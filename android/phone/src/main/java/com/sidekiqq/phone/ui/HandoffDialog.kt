package com.sidekiqq.phone.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.sidekiqq.phone.handoff.HandoffPlan
import com.sidekiqq.shared.model.DeviceCommand

/**
 * The hand-off screen: a command started on another device ("call Dana" on the watch) waiting for
 * the owner on this phone. Shows the brain-built label and, on its own line, the exact number or
 * link that will be opened. Nothing happens until the owner taps the open button; tapping outside
 * does nothing (the owner must choose open or dismiss).
 */
@Composable
fun HandoffDialog(
    command: DeviceCommand,
    plan: HandoffPlan,
    onOpen: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = {},
        properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false),
        title = { Text("From your ${command.from}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(command.label, style = MaterialTheme.typography.bodyLarge)
                when (plan) {
                    is HandoffPlan.Dial -> Text(plan.number, style = MaterialTheme.typography.headlineSmall)
                    is HandoffPlan.WhatsApp -> {
                        Text(plan.number, style = MaterialTheme.typography.headlineSmall)
                        Text("Opens a WhatsApp chat. Start the call there.", style = MaterialTheme.typography.bodySmall)
                    }
                    is HandoffPlan.Browser -> {
                        Text(plan.host, style = MaterialTheme.typography.titleMedium)
                        Text(plan.url, style = MaterialTheme.typography.bodySmall)
                    }
                    is HandoffPlan.CantOpen -> Text(
                        plan.reason,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                if (plan is HandoffPlan.Dial) {
                    Text(
                        "Opens the dialer. You still tap Call.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = {
            if (plan !is HandoffPlan.CantOpen) Button(onClick = onOpen) { Text(plan.actionLabel) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Dismiss") } },
    )
}
