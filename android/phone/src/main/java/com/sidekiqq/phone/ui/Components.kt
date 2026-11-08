package com.sidekiqq.phone.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.sidekiqq.phone.ui.theme.color
import com.sidekiqq.shared.model.DraftKind
import com.sidekiqq.shared.model.Importance

@Composable
fun ImportanceChip(importance: Importance) {
    AssistChip(
        onClick = {},
        enabled = false,
        label = { Text(importance.name) },
        colors = AssistChipDefaults.assistChipColors(
            disabledContainerColor = importance.color().copy(alpha = 0.15f),
            disabledLabelColor = importance.color(),
        ),
    )
}

@Composable
fun SectionCard(
    title: String,
    subtitle: String? = null,
    importance: Importance? = null,
    modifier: Modifier = Modifier,
    trailing: @Composable () -> Unit = {},
    body: @Composable (() -> Unit)? = null,
) {
    Card(modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                importance?.let { ImportanceChip(it) }
                trailing()
            }
            subtitle?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            body?.invoke()
        }
    }
}

/**
 * The single confirmation gate in the phone UI for sending anything.
 * Shows exactly what will be sent and to whom; dismissing does nothing.
 */
@Composable
fun ApproveDraftDialog(
    recipient: String?,
    message: String?,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    /** The draft's kind ([DraftKind]); null = email (older brains). Unknown kinds get no Send button. */
    kind: String? = null,
) {
    val k = DraftKind.of(kind)
    val invite = k == DraftKind.CALENDAR_INVITE
    val approvable = k in DraftKind.APPROVABLE
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                when {
                    !approvable -> "Review in the dashboard"
                    invite -> "Send this invite?"
                    recipient != null -> "Send to $recipient?"
                    else -> "Send this draft?"
                }
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    message ?: if (invite) "Send the calendar invite SideKiqq prepared." else "Send the draft SideKiqq prepared. Review it in Gmail first if you're unsure.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    when {
                        !approvable -> "This app can't approve this kind of draft yet. Nothing was sent."
                        invite -> "Google Calendar will email an invitation to every attendee from your account. It can't be unsent."
                        else -> "This message will be sent from your account. It can't be unsent."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            if (approvable) Button(onClick = onConfirm) { Text(if (invite) "Send invite" else "Send") }
            else TextButton(onClick = onDismiss) { Text("OK") }
        },
        dismissButton = { if (approvable) TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Labels inferred data so it is never presented as confirmed. */
@Composable
fun InferredTag() {
    Text("INFERRED", style = MaterialTheme.typography.labelSmall, color = Color(0xFFE8710A))
}
