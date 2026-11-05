"""SideKiqq on Reachy Mini: the desk-robot face of Stimmel's AI executive assistant.

The daemon starts this module as a subprocess (``python -m sidekiqq_reachy.main``) and
stops it with SIGINT, which sets ``stop_event``.
"""

from __future__ import annotations

import logging
import queue
import sys
import threading
import time
from typing import Any, Callable

import numpy as np
from fastapi import HTTPException, Request  # module-level: FastAPI resolves string annotations here
from reachy_mini import ReachyMini, ReachyMiniApp
from starlette.concurrency import run_in_threadpool

from .alerts import AlertPoller, alert_speech
from .assistant import Assistant, Outcome
from .commands import CommandPoller, Wake, run_wake
from .audio import EndpointConfig, EndpointEvent, Endpointer, FrameAssembler, mic_to_pcm16
from .config import ConfigStore, SettingsError
from .controller import Controller
from .expressions import RobotBody

log = logging.getLogger("sidekiqq_reachy")

MAX_SPOKEN_ALERTS = 3


def register_routes(app: Any, ctl: Controller) -> None:
    """JSON API for the settings page (static/index.html). Every POST requires
    Content-Type: application/json, so a random web page can't drive the robot with a
    cross-site form post (browsers preflight JSON, and there is no CORS allowance)."""
    async def body(request: Request) -> dict[str, Any]:
        if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
            raise HTTPException(415, "Content-Type must be application/json")
        try:
            data = await request.json()
        except ValueError:
            raise HTTPException(400, "Body must be JSON") from None
        if not isinstance(data, dict):
            raise HTTPException(400, "Body must be a JSON object")
        return data

    @app.get("/sk/status")
    def status() -> dict[str, Any]:
        return ctl.status()

    @app.post("/sk/settings")
    async def settings(request: Request) -> dict[str, Any]:
        data = await body(request)
        try:
            return ctl.update_settings(data)
        except (SettingsError, ValueError, TypeError) as e:
            raise HTTPException(400, str(e)) from None

    @app.post("/sk/pair")
    async def pair(request: Request) -> dict[str, Any]:
        data = await body(request)
        try:
            return await run_in_threadpool(ctl.pair, str(data.get("brain_url", "")), str(data.get("code", "")))
        except SettingsError as e:
            raise HTTPException(400, str(e)) from None

    @app.post("/sk/unpair")
    async def unpair(request: Request) -> dict[str, Any]:
        await body(request)
        return ctl.unpair()

    def action(name: str, fn: Callable[[], None]) -> None:
        async def handler(request: Request) -> dict[str, Any]:
            await body(request)
            fn()
            return ctl.status()

        app.post(f"/sk/{name}")(handler)

    action("talk", ctl.request_talk)
    action("brief", ctl.request_brief)
    action("cancel", ctl.request_cancel)


class VoiceLoop:
    """Mic reader + activation + endpointing on the app's main thread.
    Network work (a voice turn, a brief, alert delivery, a wake from another device) runs on one
    worker thread at a time. Alerts and device commands are polled on a background thread."""

    def __init__(self, media: Any, body: RobotBody, assistant: Assistant, ctl: Controller, stop_event: threading.Event) -> None:
        self.media = media
        self.body = body
        self.assistant = assistant
        self.ctl = ctl
        self.stop = stop_event
        self.assembler = FrameAssembler()
        self.endpointer: Endpointer | None = None
        self.worker: threading.Thread | None = None
        self.alerts: queue.Queue[dict[str, Any]] = queue.Queue()
        self.wake: Any = None
        self.poller = AlertPoller(
            client_factory=ctl.client,
            load_cursor=ctl.load_cursor,
            save_cursor=ctl.save_cursor,
            interval_s=lambda: float(ctl.settings.alert_poll_seconds),
            max_age_s=lambda: float(ctl.settings.alert_max_age_minutes) * 60,
        )
        # reachy_wake hand-offs from the owner's other devices (GET /api/commands). Same thread and
        # backoff as alerts; the interval is capped at 30 s like the phone's.
        self.commands = CommandPoller(
            client_factory=ctl.client,
            load_handled=ctl.load_handled_commands,
            save_handled=ctl.save_handled_commands,
            interval_s=lambda: float(ctl.settings.alert_poll_seconds),
        )

    # ------------------------------------------------------------------ threads

    def _spawn(self, name: str, fn: Callable[..., Any], *args: Any) -> None:
        def run() -> None:
            try:
                fn(*args)
            except Exception:  # noqa: BLE001
                log.exception("%s failed", name)
                self.ctl.set_status("error", f"{name} failed")
                self.body.thinking_stop()
            finally:
                self.ctl.awaiting_confirm = self.assistant.awaiting_confirm
                if self.ctl.state not in ("error",):
                    self.ctl.set_status("awaiting_confirm" if self.assistant.awaiting_confirm else "idle")

        self.worker = threading.Thread(target=run, name=f"sk-{name}", daemon=True)
        self.worker.start()

    def _busy(self) -> bool:
        return self.worker is not None and self.worker.is_alive()

    def _alert_thread(self) -> None:
        while not self.stop.is_set():
            if self.poller.due():
                res = self.poller.poll()
                if res.unauthorized:
                    self.ctl.mark_unauthorized()
                elif res.error and res.error != "not paired":
                    log.info("alert poll: %s", res.error)
                for a in res.attention:
                    self.alerts.put(a)
            if self.commands.due():
                cres = self.commands.poll()
                if cres.unauthorized:
                    self.ctl.mark_unauthorized()
                elif cres.error and cres.error != "not paired":
                    log.info("command poll: %s", cres.error)
                for w in cres.new:
                    log.info("wake from another device: %s (%s)", w.activity, w.id)
            self.stop.wait(1.0)

    # ------------------------------------------------------------------ actions

    def _deliver_alerts(self, items: list[dict[str, Any]]) -> None:
        self.ctl.note_alert(items[-1])
        self.body.attention()
        if self.ctl.settings.speak_alerts:
            for a in items[:MAX_SPOKEN_ALERTS]:
                if self.stop.is_set():
                    return
                self.assistant.say(alert_speech(a))
            if len(items) > MAX_SPOKEN_ALERTS:
                self.assistant.say(f"And {len(items) - MAX_SPOKEN_ALERTS} more alerts in the app.")
        self.body.neutral()

    def _turn(self, pcm: np.ndarray | None) -> None:
        outcome = self.assistant.handle_utterance(pcm)
        log.info("turn: %s", outcome.value)
        if outcome not in (Outcome.AWAITING_CONFIRM,):
            self.body.neutral()

    def _start_listening(self, timeout_s: float | None = None) -> None:
        cfg = EndpointConfig()
        if timeout_s is not None:
            cfg.no_speech_timeout_ms = max(1000, int(timeout_s * 1000))
        self.endpointer = Endpointer(cfg)
        self.assembler.reset()
        self.ctl.set_status("listening")
        self.body.listening()

    def _refresh_wake_word(self) -> None:
        s = self.ctl.settings
        if not s.wake_word_enabled:
            self.wake = None
            self.ctl.wake_word_status = "off"
            return
        try:
            from .wakeword import WakeWord

            self.wake = WakeWord(s.wake_word_model, s.wake_word_threshold)
            self.ctl.wake_word_status = f"listening for '{s.wake_word_model}' (on-device)"
        except Exception as e:  # noqa: BLE001
            self.wake = None
            self.ctl.wake_word_status = f"unavailable: {e}"
            log.warning("wake word unavailable: %s", e)

    # ------------------------------------------------------------------ main loop

    def run(self) -> None:
        self.media.start_recording()
        src_rate = int(self.media.get_input_audio_samplerate() or 16000)
        threading.Thread(target=self._alert_thread, name="sk-alerts", daemon=True).start()
        self._refresh_wake_word()
        self.body.neutral()
        self.ctl.set_status("idle")
        try:
            while not self.stop.is_set():
                sample = self.media.get_audio_sample()
                frames: list[np.ndarray] = []
                if sample is not None and len(sample):
                    frames = self.assembler.push(mic_to_pcm16(sample, src_rate))
                else:
                    time.sleep(0.01)

                if self.ctl.settings_changed.is_set():
                    self.ctl.settings_changed.clear()
                    self._refresh_wake_word()

                # Half-duplex: drop mic audio while a turn is running or the robot is talking.
                if self._busy() or self.body.speaking.is_set():
                    continue

                if self.ctl.cancel_requested.is_set():
                    self.ctl.cancel_requested.clear()
                    # Also stops a listen that was requested but hasn't started (e.g. by a chat wake).
                    self.ctl.talk_requested.clear()
                    if self.endpointer is not None and not self.assistant.awaiting_confirm:
                        self.endpointer = None
                        self.body.neutral()
                        self.ctl.set_status("idle")
                    if self.assistant.awaiting_confirm:
                        self.endpointer = None
                        self._spawn("cancel", self._cancel_draft)
                    continue

                if self.endpointer is not None:
                    for f in frames:
                        ev = self.endpointer.feed(f)
                        if ev in (EndpointEvent.ENDED, EndpointEvent.MAX_LENGTH):
                            pcm = self.endpointer.utterance()
                            self.endpointer = None
                            self._spawn("turn", self._turn, pcm)
                            break
                        if ev is EndpointEvent.NO_SPEECH:
                            self.endpointer = None
                            self._spawn("turn", self._turn, None)
                            break
                    continue

                # Idle. A draft waiting for "send it" listens for its answer automatically.
                if self.assistant.awaiting_confirm:
                    self._start_listening(timeout_s=self.assistant.confirm.remaining_s())
                    continue
                if self.ctl.talk_requested.is_set():
                    self.ctl.talk_requested.clear()
                    self._start_listening()
                    continue
                if self.wake is not None and frames and self.wake.feed(np.concatenate(frames)):
                    log.info("wake word heard")
                    self._start_listening()
                    continue
                if self.ctl.brief_requested.is_set():
                    self.ctl.brief_requested.clear()
                    self.ctl.set_status("briefing")
                    self._spawn("brief", self._brief)
                    continue
                # A wake from another device runs only here, when nothing else is going on (it
                # waits in CommandPoller while the robot is busy, see commands.py).
                wake = self.commands.take()
                if wake is not None:
                    self._spawn("wake", self._wake, wake)
                    continue
                pending = self._drain_alerts()
                if pending:
                    self._spawn("alerts", self._deliver_alerts, pending)
        finally:
            self.body.thinking_stop()
            try:
                self.media.stop_recording()
            except Exception:  # noqa: BLE001
                pass
            self.body.close()

    def _drain_alerts(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        while True:
            try:
                items.append(self.alerts.get_nowait())
            except queue.Empty:
                return items

    def _brief(self) -> None:
        self.assistant.brief("daily")
        self.body.neutral()

    def _wake(self, wake: Wake) -> None:
        result = "failed"
        try:
            result = run_wake(wake, self.assistant, self.body, self.ctl.request_talk, on_status=self.ctl.set_status)
        finally:
            # Ack off the worker, so a chat's listen isn't held up by a slow brain.
            threading.Thread(target=self.commands.complete, args=(wake, result), name="sk-ack", daemon=True).start()

    def _cancel_draft(self) -> None:
        self.assistant.cancel_pending()
        self.body.neutral()


class SidekiqqReachy(ReachyMiniApp):
    # Settings page (static/index.html): http://reachy-mini.local:8042 (Wireless) or http://localhost:8042 (Lite)
    custom_app_url: str | None = "http://0.0.0.0:8042"
    request_media_backend: str | None = None

    def run(self, reachy_mini: ReachyMini, stop_event: threading.Event) -> None:
        logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s %(name)s %(levelname)s %(message)s")
        log.info("SideKiqq for Reachy Mini starting (python %s)", sys.version.split()[0])
        ctl = Controller(ConfigStore())
        if self.settings_app is not None:
            register_routes(self.settings_app, ctl)
        body = RobotBody(reachy_mini, stop_event)
        assistant = Assistant(
            ctl.client,
            body,
            voice=lambda: ctl.settings.voice,
            on_unauthorized=ctl.mark_unauthorized,
            on_status=ctl.set_status,
        )
        VoiceLoop(reachy_mini.media, body, assistant, ctl, stop_event).run()
        log.info("SideKiqq for Reachy Mini stopped")


if __name__ == "__main__":
    app = SidekiqqReachy()
    try:
        app.wrapped_run()
    except KeyboardInterrupt:
        app.stop()
