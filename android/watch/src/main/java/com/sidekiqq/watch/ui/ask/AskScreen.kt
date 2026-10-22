package com.sidekiqq.watch.ui.ask

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.CompactChip
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.sidekiqq.shared.model.ActionType
import com.sidekiqq.watch.logic.PushToTalk
import com.sidekiqq.watch.ui.Routes
import com.sidekiqq.watch.ui.components.SkScaffold
import com.sidekiqq.watch.ui.theme.SkColors

/**
 * Home screen. A big round push-to-talk button sits on top, and the answer appears beneath it:
 * `spoken` in large type, then the full `reply` when you scroll. Navigation chips sit below.
 */
@Composable
fun AskScreen(onNavigate: (String) -> Unit, vm: AskViewModel = viewModel()) {
    val ui by vm.ui.collectAsState()
    val context = LocalContext.current

    val remoteInput = rememberRemoteInputLauncher { vm.askText(it) }
    val voiceLabel = "Ask SideKiqq"

    fun hasMic() = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED

    // If the user denies the mic, fall back to system voice input instead of a dead button.
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) remoteInput.launch(RemoteInputVoice.intent(voiceLabel))
    }

    SkScaffold {
        item {
            PushToTalkButton(
                ui = ui,
                onPressStart = {
                    if (hasMic()) {
                        vm.startRecording()
                    } else {
                        micPermission.launch(Manifest.permission.RECORD_AUDIO)
                        false
                    }
                },
                onRelease = { heldMs ->
                    when (PushToTalk.onRelease(heldMs)) {
                        PushToTalk.Release.SEND -> vm.stopAndSend()
                        PushToTalk.Release.LATCH -> vm.latch()
                    }
                },
                onTapWhileLatched = { vm.stopAndSend() },
            )
        }

        if (!vm.isPaired) {
            item {
                Text(
                    "Not paired yet. Pair from the phone app, or open Settings.",
                    textAlign = TextAlign.Center,
                    color = SkColors.High,
                    fontSize = 12.sp,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                )
            }
        }

        when (val s = ui) {
            is AskUi.Answer -> {
                item {
                    Text(
                        s.question,
                        color = SkColors.Muted,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        maxLines = 2,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                    )
                }
                item {
                    Text(
                        s.spoken,
                        style = MaterialTheme.typography.title2,
                        fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                    )
                }
                if (s.reply.isNotBlank() && s.reply != s.spoken) {
                    item {
                        Text(
                            s.reply,
                            style = MaterialTheme.typography.body2,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                        )
                    }
                }
                s.actions.forEach { a ->
                    item {
                        val isDraft = a.type == ActionType.DRAFT_CREATED
                        // Drafts are never sent from here; this only opens Follow-ups, where Approve then confirm applies.
                        Chip(
                            onClick = { if (isDraft) onNavigate(Routes.FOLLOWUPS) },
                            label = { Text(a.summary, maxLines = 2) },
                            secondaryLabel = { Text(if (isDraft) "Review & approve" else a.type.name.lowercase().replace('_', ' ')) },
                            colors = ChipDefaults.secondaryChipColors(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                item {
                    CompactChip(onClick = { vm.newConversation() }, label = { Text("New topic") })
                }
            }

            is AskUi.Thinking -> item {
                Text("“${s.question}”", color = SkColors.Muted, textAlign = TextAlign.Center, maxLines = 3)
            }

            is AskUi.Error -> item {
                Text(s.message, color = MaterialTheme.colors.error, textAlign = TextAlign.Center)
            }

            else -> Unit
        }

        item {
            Chip(
                onClick = { remoteInput.launch(RemoteInputVoice.intent(voiceLabel)) },
                label = { Text("Type / dictate") },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        navChip("Top 5", Routes.TOP5, onNavigate)
        navChip("Follow-ups", Routes.FOLLOWUPS, onNavigate)
        navChip("Commitments", Routes.COMMITMENTS, onNavigate)
        navChip("Last medallion reply", Routes.REPLY, onNavigate)
        navChip("Settings", Routes.SETTINGS, onNavigate)
    }
}

private fun androidx.wear.compose.foundation.lazy.ScalingLazyListScope.navChip(
    label: String,
    route: String,
    onNavigate: (String) -> Unit,
) = item {
    Chip(
        onClick = { onNavigate(route) },
        label = { Text(label) },
        colors = ChipDefaults.primaryChipColors(),
        modifier = Modifier.fillMaxWidth(),
    )
}

/**
 * Press and hold to talk, or tap once to latch recording on and tap again to send.
 * [onPressStart] returns false if recording could not start, e.g. a permission prompt is showing.
 */
@Composable
private fun PushToTalkButton(
    ui: AskUi,
    onPressStart: () -> Boolean,
    onRelease: (heldMs: Long) -> Unit,
    onTapWhileLatched: () -> Unit,
) {
    val state by rememberUpdatedState(ui)
    val start by rememberUpdatedState(onPressStart)
    val release by rememberUpdatedState(onRelease)
    val tapLatched by rememberUpdatedState(onTapWhileLatched)

    val recording = ui is AskUi.Recording
    val busy = ui is AskUi.Transcribing || ui is AskUi.Thinking
    val label = when (ui) {
        is AskUi.Recording -> if (ui.latched) "Listening…\ntap to send" else "Listening…\nrelease to send"
        AskUi.Transcribing -> "Transcribing…"
        is AskUi.Thinking -> "Thinking…"
        else -> "Ask\nSideKiqq"
    }

    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .padding(top = 8.dp)
            .size(118.dp)
            .clip(CircleShape)
            .background(if (recording) SkColors.Recording else SkColors.Brand)
            .semantics {
                contentDescription = "Ask SideKiqq. Hold to talk, or tap to start and tap again to send."
                role = Role.Button
                // Accessibility click works like a tap: latch on, then send.
                onClick {
                    val s = state
                    if (s is AskUi.Recording) tapLatched() else if (start()) release(0L)
                    true
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(
                    onPress = {
                        val s = state
                        if (s is AskUi.Transcribing || s is AskUi.Thinking) return@detectTapGestures
                        if (s is AskUi.Recording && s.latched) {
                            tryAwaitRelease()
                            tapLatched()
                            return@detectTapGestures
                        }
                        val t0 = System.currentTimeMillis()
                        if (!start()) return@detectTapGestures
                        tryAwaitRelease() // returns false if the gesture was cancelled (e.g. scrolling)
                        release(System.currentTimeMillis() - t0)
                    },
                )
            },
    ) {
        if (busy) {
            CircularProgressIndicator(modifier = Modifier.size(118.dp), strokeWidth = 4.dp)
        }
        Text(
            label,
            textAlign = TextAlign.Center,
            fontWeight = FontWeight.Bold,
            fontSize = if (recording || busy) 13.sp else 17.sp,
            color = androidx.compose.ui.graphics.Color.White,
        )
    }
}
