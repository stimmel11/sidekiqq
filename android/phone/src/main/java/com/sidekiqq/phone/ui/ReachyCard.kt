package com.sidekiqq.phone.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sidekiqq.phone.reachy.FoundReachy
import com.sidekiqq.shared.model.ReachyActivity

/**
 * "Start up Reachy and let's do something." Each button is the owner's tap: the phone starts the
 * SideKiqq app on the robot over home Wi-Fi if needed, then asks Reachy to wake up for that activity.
 */
@Composable
fun ReachyCard(
    host: String,
    starting: Boolean,
    onStart: (activity: String) -> Unit,
    onSaveHost: (String) -> Boolean,
    searching: Boolean = false,
    found: List<FoundReachy>? = null,
    onFind: () -> Unit = {},
    onChooseFound: (FoundReachy) -> Unit = {},
    onDismissFound: () -> Unit = {},
) {
    var editing by rememberSaveable { mutableStateOf(false) }
    var draft by rememberSaveable { mutableStateOf(host) }

    SectionCard(
        title = "Reachy",
        subtitle = when {
            starting -> "Starting SideKiqq on Reachy…"
            searching -> "Looking for Reachy on this Wi-Fi…"
            else -> "On the same Wi-Fi as $host"
        },
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = !starting && !searching, onClick = { onStart(ReachyActivity.CHAT) }, modifier = Modifier.weight(1f)) { Text("Chat", maxLines = 1) }
            OutlinedButton(enabled = !starting && !searching, onClick = { onStart(ReachyActivity.BRIEF) }, modifier = Modifier.weight(1f)) { Text("Brief", maxLines = 1) }
            OutlinedButton(enabled = !starting && !searching, onClick = { onStart(ReachyActivity.DANCE) }, modifier = Modifier.weight(1f)) { Text("Dance", maxLines = 1) }
        }
        if (!found.isNullOrEmpty()) {
            // Anyone on the Wi-Fi can answer a search, so each entry shows the exact address it
            // would save; nothing is saved until the owner taps one.
            Text("Found on this Wi-Fi. Tap the one to use:", style = MaterialTheme.typography.bodyMedium)
            for (f in found) {
                OutlinedButton(enabled = !starting, onClick = { onChooseFound(f) }, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth()) {
                        if (f.name != f.host.host) Text(f.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        // The address it would save, in full (never ellipsized).
                        Text(f.host.display, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            TextButton(onClick = onDismissFound) { Text("Not now") }
        }
        if (editing) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it.take(80) },
                label = { Text("Reachy address") },
                supportingText = { Text("Its .local name, for example reachy-mini.local") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { if (onSaveHost(draft)) editing = false }) { Text("Save") }
                TextButton(onClick = { draft = host; editing = false }) { Text("Cancel") }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(enabled = !starting && !searching, onClick = onFind) {
                    Text(if (searching) "Searching…" else "Find Reachy", style = MaterialTheme.typography.labelLarge)
                }
                TextButton(enabled = !starting, onClick = { draft = host; editing = true }) {
                    Text("Change address", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}
