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
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (recipient != null) "Send to $recipient?" else "Send this draft?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    message ?: "Send the draft SideKiqq prepared. Review it in Gmail first if you're unsure.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "This message will be sent from your account. It can't be unsent.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = { Button(onClick = onConfirm) { Text("Send") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Labels inferred data so it is never presented as confirmed. */
@Composable
fun InferredTag() {
    Text("INFERRED", style = MaterialTheme.typography.labelSmall, color = Color(0xFFE8710A))
}
