"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { cx } from "@/components/ui/cx";
import { icons } from "@/components/ui/icons";
import type { SpeakOutcome, TalkOutcome } from "@/lib/dashboard/talk";
import type { Action } from "@/lib/models";
import { Endpointer, MAX_SECONDS, base64ToBytes, framesToWav } from "@/lib/talk/audio";
import { askTextAction, speakAction, talkAction } from "../actions";

/**
 * Browser tap-to-talk (docs/WEBAPP.md §6). Tap → mic on (AudioWorklet, or ScriptProcessor where
 * worklets are missing) → stop on 2 s of quiet, a second tap or 30 s → every mic track stopped →
 * 16 kHz WAV → transcribe → ask as `web` → reply shown and `spoken` played through the same
 * AudioContext. A draft only links to the Drafts screen: a spoken "send it" is not accepted here.
 */

type Phase = "idle" | "starting" | "listening" | "thinking" | "speaking";

interface Turn {
  id: number;
  you: string;
  reply: string;
  actions: Action[];
}

const MUTE_KEY = "skq.talk.muted";

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMuted(v: boolean) {
  try {
    window.localStorage.setItem(MUTE_KEY, v ? "1" : "0");
  } catch {
    // storage blocked: the toggle still works for this page
  }
}

interface Recorder {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioNode;
  sink: GainNode;
  frames: Float32Array[];
  endpointer: Endpointer;
  stopping: boolean;
}

let workletLoaded: WeakSet<AudioContext> | null = null;

async function captureNode(ctx: AudioContext, onFrame: (f: Float32Array) => void): Promise<AudioNode> {
  if (typeof AudioWorkletNode !== "undefined" && ctx.audioWorklet) {
    try {
      workletLoaded ??= new WeakSet();
      if (!workletLoaded.has(ctx)) {
        await ctx.audioWorklet.addModule("/talk-capture-worklet.js");
        workletLoaded.add(ctx);
      }
      const node = new AudioWorkletNode(ctx, "skq-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      node.port.onmessage = (e: MessageEvent) => {
        if (e.data instanceof Float32Array) onFrame(e.data);
      };
      return node;
    } catch {
      // fall through to the ScriptProcessor fallback
    }
  }
  const sp = ctx.createScriptProcessor(4096, 1, 1);
  sp.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
  return sp;
}

function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was blocked. Allow it for this site in the browser's settings, or type instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Type instead.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return "The microphone couldn't start. Type instead.";
}

export function TalkPanel() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [typed, setTyped] = useState("");
  const [seconds, setSeconds] = useState(0);
  const ctxRef = useRef<AudioContext | null>(null);
  const recRef = useRef<Recorder | null>(null);
  const playingRef = useRef<AudioBufferSourceNode | null>(null);
  const conversationRef = useRef<string | null>(null);
  const turnId = useRef(0);
  const busyRef = useRef(false);
  const mutedRef = useRef(false);
  /** Bumped by every stop; a voice reply that arrives after a stop is dropped. */
  const playGenRef = useRef(0);
  const unmountedRef = useRef(false);
  const voiceErrorShownRef = useRef(false);

  useEffect(() => {
    const m = readMuted();
    mutedRef.current = m;
    setMuted(m);
  }, []);

  const releaseMic = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    for (const t of rec.stream.getTracks()) t.stop();
    try {
      rec.source.disconnect();
      rec.node.disconnect();
      rec.sink.disconnect();
      if (rec.node instanceof AudioWorkletNode) rec.node.port.postMessage("stop");
    } catch {
      // already disconnected
    }
  }, []);

  const stopPlayback = useCallback(() => {
    playGenRef.current++;
    const src = playingRef.current;
    playingRef.current = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // not started
      }
    }
  }, []);

  useEffect(
    () => () => {
      unmountedRef.current = true;
      releaseMic();
      stopPlayback();
      void ctxRef.current?.close().catch(() => undefined);
    },
    [releaseMic, stopPlayback],
  );

  const speak = useCallback(
    async (spoken: string) => {
      const ctx = ctxRef.current;
      if (!spoken || mutedRef.current || !ctx) {
        setPhase("idle");
        return;
      }
      const gen = playGenRef.current;
      setPhase("speaking");
      let out: SpeakOutcome;
      try {
        out = await speakAction(spoken);
      } catch {
        out = { ok: false, error: "The voice reply isn't available right now." };
      }
      if (playGenRef.current !== gen || unmountedRef.current) return; // stopped while loading
      if (!out.ok) {
        // Show a voice problem once per page, not on every turn (e.g. TTS not configured).
        if (!voiceErrorShownRef.current) setError(out.error);
        voiceErrorShownRef.current = true;
        setPhase("idle");
        return;
      }
      try {
        const bytes = base64ToBytes(out.wavBase64);
        const buffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        await ctx.resume();
        if (playGenRef.current !== gen || unmountedRef.current) return;
        const old = playingRef.current;
        if (old) {
          old.onended = null;
          try {
            old.stop();
          } catch {
            // not started
          }
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = () => {
          if (playingRef.current === src) playingRef.current = null;
          setPhase((p) => (p === "speaking" ? "idle" : p));
        };
        playingRef.current = src;
        src.start();
      } catch {
        if (playGenRef.current !== gen) return;
        setError("The voice reply couldn't be played.");
        setPhase("idle");
      }
    },
    [],
  );

  const handleOutcome = useCallback(
    async (out: TalkOutcome) => {
      if (!out.ok) {
        setError(out.error);
        if (out.text) setTyped(out.text);
        setPhase("idle");
        return;
      }
      if (out.conversationId) conversationRef.current = out.conversationId;
      setTurns((t) => [...t, { id: ++turnId.current, you: out.text, reply: out.reply, actions: out.actions }]);
      setTyped("");
      // The turn is done: a new tap or typed question may start while the voice reply loads/plays.
      busyRef.current = false;
      if (out.spoken && !mutedRef.current) await speak(out.spoken);
      else setPhase("idle");
    },
    [speak],
  );

  const finish = useCallback(
    async (reason: "tap" | "silence" | "no_speech" | "max" | "hidden") => {
      const rec = recRef.current;
      const ctx = ctxRef.current;
      if (!rec || !ctx || rec.stopping) return;
      rec.stopping = true;
      const heard = rec.endpointer.heardSpeech;
      const frames = rec.frames;
      releaseMic(); // mic indicator off before anything is uploaded
      if (reason === "no_speech" || (!heard && reason !== "tap")) {
        if (reason !== "hidden") setError("I didn't hear anything. Tap the mic and try again.");
        setPhase("idle");
        busyRef.current = false;
        return;
      }
      setPhase("thinking");
      try {
        await new Promise((r) => setTimeout(r, 0)); // let "Thinking…" paint before encoding
        const wav = framesToWav(frames, ctx.sampleRate);
        const form = new FormData();
        form.append("audio", new Blob([wav as BlobPart], { type: "audio/wav" }), "talk.wav");
        if (conversationRef.current) form.append("conversationId", conversationRef.current);
        let out: TalkOutcome;
        try {
          out = await talkAction(form);
        } catch {
          out = { ok: false, error: "Couldn't reach SideKiqq. Check the connection and try again." };
        }
        await handleOutcome(out);
      } catch {
        setError("The recording couldn't be prepared. Try again, or type instead.");
        setPhase("idle");
      } finally {
        busyRef.current = false;
      }
    },
    [handleOutcome, releaseMic],
  );

  const start = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    stopPlayback();
    setPhase("starting");
    // Create/resume the AudioContext inside the tap (required on iOS) before awaiting anything else.
    let ctx = ctxRef.current;
    try {
      if (!ctx) {
        ctx = new AudioContext();
        ctxRef.current = ctx;
      }
      void ctx.resume().catch(() => undefined);
    } catch {
      setError("Audio isn't available in this browser. Type instead.");
      setPhase("idle");
      busyRef.current = false;
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't use the microphone here (it needs HTTPS). Type instead.");
      setPhase("idle");
      busyRef.current = false;
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      setError(micError(err));
      setPhase("idle");
      busyRef.current = false;
      return;
    }
    // Unmounted or backgrounded while the permission prompt was up: never record in the background.
    if (unmountedRef.current || document.visibilityState === "hidden") {
      for (const t of stream.getTracks()) t.stop();
      if (!unmountedRef.current) setPhase("idle");
      busyRef.current = false;
      return;
    }
    try {
      const frames: Float32Array[] = [];
      const endpointer = new Endpointer();
      const rate = ctx.sampleRate;
      let rec: Recorder | null = null;
      const node = await captureNode(ctx, (f) => {
        if (!rec || rec.stopping || recRef.current !== rec) return;
        frames.push(f);
        const decision = endpointer.feed(f, rate);
        if (decision !== "continue") void finish(decision);
      });
      const source = ctx.createMediaStreamSource(stream);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      rec = { stream, source, node, sink, frames, endpointer, stopping: false };
      recRef.current = rec;
      await ctx.resume();
      if (unmountedRef.current) throw new Error("unmounted");
      setPhase("listening");
    } catch {
      releaseMic();
      for (const t of stream.getTracks()) t.stop();
      setError("The microphone couldn't start. Type instead.");
      setPhase("idle");
      busyRef.current = false;
    }
  }, [finish, releaseMic, stopPlayback]);

  // Elapsed-time counter while listening.
  useEffect(() => {
    if (phase !== "listening") {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const t = window.setInterval(() => setSeconds(Math.min(MAX_SECONDS, Math.floor((Date.now() - startedAt) / 1000))), 250);
    return () => window.clearInterval(t);
  }, [phase]);

  // Stop the mic if the page is hidden mid-recording (no open mic in the background).
  useEffect(() => {
    const onHide = () => {
      // Upload only if something was said; otherwise just turn the mic off.
      if (document.visibilityState === "hidden" && recRef.current) void finish("hidden");
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [finish]);

  const onMic = () => {
    if (phase === "listening") void finish("tap");
    else if (phase === "speaking") {
      stopPlayback();
      setPhase("idle");
    } else if (phase === "idle") void start();
  };

  const onTyped = async (e: FormEvent) => {
    e.preventDefault();
    if (phase !== "idle" || busyRef.current || !typed.trim()) return;
    busyRef.current = true;
    setError(null);
    // A typed turn may still be spoken: set up audio inside this user gesture.
    if (!mutedRef.current && !ctxRef.current) {
      try {
        ctxRef.current = new AudioContext();
      } catch {
        // no audio: the reply is still shown
      }
    }
    void ctxRef.current?.resume().catch(() => undefined);
    setPhase("thinking");
    try {
      let out: TalkOutcome;
      try {
        out = await askTextAction(typed, conversationRef.current);
      } catch {
        out = { ok: false, error: "Couldn't reach SideKiqq. Check the connection and try again.", text: typed };
      }
      await handleOutcome(out);
    } finally {
      busyRef.current = false;
    }
  };

  const toggleMute = () => {
    const next = !muted;
    mutedRef.current = next;
    setMuted(next);
    writeMuted(next);
    if (next && phase === "speaking") {
      stopPlayback();
      setPhase("idle");
    }
  };

  const newConversation = () => {
    conversationRef.current = null;
    setTurns([]);
    setError(null);
  };

  const status: Record<Phase, string> = {
    idle: "Tap to talk",
    starting: "Starting the mic…",
    listening: `Listening… ${seconds}s · tap to stop`,
    thinking: "Thinking…",
    speaking: "Speaking · tap to stop",
  };
  const micLabel = phase === "listening" ? "Stop and send" : phase === "speaking" ? "Stop speaking" : "Start talking";

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface px-5 py-8" aria-label="Voice">
        <button
          type="button"
          onClick={onMic}
          disabled={phase === "starting" || phase === "thinking"}
          aria-label={micLabel}
          aria-pressed={phase === "listening"}
          className={cx(
            "flex h-24 w-24 items-center justify-center rounded-pill transition-colors duration-fast focus-visible:outline-accent",
            "disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:h-10 [&_svg]:w-10",
            phase === "listening" ? "bg-danger text-danger-text" : "bg-accent text-accent-text hover:brightness-95",
          )}
        >
          {icons.talk}
        </button>
        <p className="font-mono text-data text-text-muted" role="status" aria-live="polite">
          {status[phase]}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" variant="ghost" onClick={toggleMute} aria-pressed={muted}>
            {muted ? "Voice off" : "Voice on"}
          </Button>
          {turns.length > 0 && (
            <Button size="sm" variant="ghost" onClick={newConversation} disabled={phase !== "idle"}>
              New conversation
            </Button>
          )}
        </div>
      </section>

      {error && <Notice tone="danger">{error}</Notice>}

      <form onSubmit={onTyped} className="flex gap-2">
        <label htmlFor="talk-typed" className="sr-only">
          Type instead
        </label>
        <input
          id="talk-typed"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          maxLength={8000}
          placeholder="Or type a question"
          autoComplete="off"
          className="min-h-touch min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 text-body text-text placeholder:text-text-muted"
        />
        <button type="submit" className={buttonClass("secondary")} disabled={phase !== "idle" || !typed.trim()}>
          Ask
        </button>
      </form>

      {turns.length > 0 && (
        <ol className="flex flex-col gap-4" aria-label="Conversation">
          {[...turns].reverse().map((t) => (
            <li key={t.id}>
              <Card>
                <p className="pt-4 text-small text-text-muted">
                  <span className="font-medium text-text">You:</span> {t.you}
                </p>
                <p className="mt-3 whitespace-pre-wrap text-body text-text">{t.reply}</p>
                {t.actions.map((a) => (
                  <ActionCard key={`${a.type}:${a.id}`} action={a} />
                ))}
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ActionCard({ action }: { action: Action }) {
  if (action.type === "draft_created") {
    const invite = action.draftKind === "calendar_invite";
    return (
      <div className="mt-4 rounded-md border border-line bg-surface-sunken px-4 py-3">
        <p className="text-small font-medium text-text">{invite ? "Invite ready for review" : "Draft ready for review"}</p>
        <p className="mt-1 text-small text-text-muted">{action.summary}</p>
        <p className="mt-2 text-small text-text-muted">Nothing has been sent. Review it and confirm on the Drafts screen.</p>
        <Link href={`/dashboard/drafts/${encodeURIComponent(action.id)}`} className={buttonClass("primary", "sm", "mt-3")}>
          Review and send
        </Link>
      </div>
    );
  }
  if (action.type === "commitment_added") {
    return <p className="mt-3 text-small text-text-muted">Commitment added: {action.summary}</p>;
  }
  return <p className="mt-3 text-small text-text-muted">{action.summary}</p>;
}
