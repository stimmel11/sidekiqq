package com.sidekiqq.watch.ui.settings

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.ToggleChip
import androidx.wear.compose.material.ToggleChipDefaults
import com.sidekiqq.watch.app
import com.sidekiqq.watch.tile.GlanceRefreshWorker
import com.sidekiqq.watch.ui.ask.RemoteInputVoice
import com.sidekiqq.watch.ui.ask.rememberRemoteInputLauncher
import com.sidekiqq.watch.ui.components.SkScaffold
import com.sidekiqq.watch.ui.components.header
import com.sidekiqq.watch.ui.components.userMessage
import com.sidekiqq.watch.ui.theme.SkColors
import com.sidekiqq.watch.wearable.TokenSync
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen() {
    val context = LocalContext.current
    val prefs = context.app.prefs
    val repo = context.app.repository
    val scope = rememberCoroutineScope()

    var tts by remember { mutableStateOf(prefs.ttsEnabled) }
    val token by prefs.tokenState.collectAsState()
    var status by remember { mutableStateOf<String?>(null) }

    // Standalone pairing (no phone nearby): enter the one-time code shown in the phone app or brain.
    val pairInput = rememberRemoteInputLauncher { code ->
        scope.launch {
            status = try {
                repo.pair(code.trim())
                GlanceRefreshWorker.refreshNow(context)
                "Paired ✓"
            } catch (e: Exception) {
                "Pairing failed: ${e.userMessage()}"
            }
        }
    }

    SkScaffold {
        header("Settings")
        item {
            ToggleChip(
                checked = tts,
                onCheckedChange = { tts = it; prefs.ttsEnabled = it },
                label = { Text("Speak answers") },
                secondaryLabel = { Text("Read the short answer aloud") },
                toggleControl = {
                    androidx.wear.compose.material.Icon(
                        imageVector = ToggleChipDefaults.switchIcon(checked = tts),
                        contentDescription = if (tts) "On" else "Off",
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            Text(
                if (token != null) "Paired with brain" else "Not paired",
                color = if (token != null) SkColors.BrandBright else SkColors.High,
                textAlign = TextAlign.Center,
            )
        }
        item {
            Text(prefs.baseUrl, color = SkColors.Muted, style = MaterialTheme.typography.caption3, textAlign = TextAlign.Center)
        }
        item {
            Chip(
                onClick = {
                    scope.launch {
                        status = if (TokenSync.pullFromDataLayer(context)) "Token synced from phone" else "No token on phone yet"
                    }
                },
                label = { Text("Sync from phone") },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            Chip(
                onClick = { pairInput.launch(RemoteInputVoice.intent("Pairing code")) },
                label = { Text("Enter pairing code") },
                secondaryLabel = { Text("Standalone, no phone") },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (token != null) {
            item {
                Chip(
                    onClick = { prefs.token = null; prefs.conversationId = null; status = "Unpaired" },
                    label = { Text("Unpair watch") },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        status?.let { s -> item { Text(s, textAlign = TextAlign.Center, style = MaterialTheme.typography.caption1) } }
    }
}
