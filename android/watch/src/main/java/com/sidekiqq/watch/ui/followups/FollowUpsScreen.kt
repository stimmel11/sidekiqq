package com.sidekiqq.watch.ui.followups

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.sidekiqq.shared.model.FollowUp
import com.sidekiqq.watch.logic.ApproveFlow
import com.sidekiqq.watch.logic.ApproveState
import com.sidekiqq.watch.ui.components.Load
import com.sidekiqq.watch.ui.components.SkScaffold
import com.sidekiqq.watch.ui.components.emptyItem
import com.sidekiqq.watch.ui.components.errorItem
import com.sidekiqq.watch.ui.components.header
import com.sidekiqq.watch.ui.components.loading
import com.sidekiqq.watch.ui.theme.SkColors
import com.sidekiqq.watch.ui.theme.importanceColor
import kotlinx.coroutines.delay

/** Scopes the ViewModel to the Activity so the list and detail screens share data. */
@Composable
private fun sharedFollowUpsVm(): FollowUpsViewModel =
    viewModel(viewModelStoreOwner = LocalContext.current as ComponentActivity)

@Composable
fun FollowUpsScreen(onOpen: (String) -> Unit, vm: FollowUpsViewModel = sharedFollowUpsVm()) {
    val state by vm.list.collectAsState()
    SkScaffold {
        header("Follow-ups")
        when (val s = state) {
            Load.Loading -> loading()
            is Load.Error -> errorItem(s.message, vm::refresh)
            is Load.Ready -> {
                if (s.data.isEmpty()) emptyItem("No follow-ups needed.")
                s.data.forEach { f ->
                    item {
                        Chip(
                            onClick = { onOpen(f.id) },
                            label = { Text(f.person, color = importanceColor(f.importance), maxLines = 1) },
                            secondaryLabel = {
                                Text(
                                    buildString {
                                        f.daysQuiet?.let { append("${it}d quiet · ") }
                                        append(f.reason)
                                    },
                                    maxLines = 2,
                                )
                            },
                            colors = ChipDefaults.secondaryChipColors(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Detail and approve. Shows the suggested message; Approve leads to "Send to <person>?", and only
 * Send there calls approveDraft. Nothing is ever sent from a single tap.
 */
@Composable
fun FollowUpDetailScreen(followUpId: String, onDone: () -> Unit, vm: FollowUpsViewModel = sharedFollowUpsVm()) {
    val list by vm.list.collectAsState()
    val approve by vm.approve.collectAsState()
    val f: FollowUp? = (list as? Load.Ready)?.data?.firstOrNull { it.id == followUpId } ?: vm.find(followUpId)

    // Each detail visit starts at Reviewing; a stale Confirming state must not carry over.
    DisposableEffect(followUpId) {
        vm.resetApproval()
        onDispose { vm.resetApproval() }
    }

    LaunchedEffect(approve) {
        if (approve is ApproveState.Sent) {
            delay(1_200)
            onDone()
        }
    }

    SkScaffold {
        if (f == null) {
            if (approve is ApproveState.Sent) item { Text("Sent ✓", color = SkColors.BrandBright) }
            else emptyItem("Follow-up not found.")
            return@SkScaffold
        }

        header(f.person)
        item {
            Text(
                f.reason,
                style = MaterialTheme.typography.body2,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            )
        }
        f.client?.let { c -> item { Text(c, color = SkColors.Muted, style = MaterialTheme.typography.caption2) } }

        val msg = f.suggestedMessage
        if (msg.isNullOrBlank()) {
            item { Text("No suggested message.", color = SkColors.Muted) }
        } else {
            item {
                Card(onClick = {}, enabled = false, modifier = Modifier.fillMaxWidth()) {
                    Text("Suggested message", color = SkColors.Muted, style = MaterialTheme.typography.caption2)
                    Text(msg, style = MaterialTheme.typography.body2)
                }
            }
        }

        // Approve only works on items with a server-side draft.
        if (f.draftId.isNullOrBlank()) {
            item {
                Text(
                    "No draft yet. Ask SideKiqq to draft one.",
                    color = SkColors.Muted,
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.caption1,
                )
            }
            return@SkScaffold
        }

        when (val a = approve) {
            ApproveState.Reviewing -> item {
                Chip(
                    onClick = vm::onApproveTapped,
                    label = { Text("Approve") },
                    colors = ChipDefaults.primaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            ApproveState.Confirming -> {
                item {
                    Text(
                        ApproveFlow.confirmPrompt(f.person),
                        style = MaterialTheme.typography.title3,
                        textAlign = TextAlign.Center,
                    )
                }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Button(
                            onClick = vm::onCancel,
                            colors = ButtonDefaults.secondaryButtonColors(),
                        ) { Text("✕") }
                        Button(
                            onClick = { vm.onConfirmTapped(f) },
                            colors = ButtonDefaults.primaryButtonColors(),
                        ) { Text("Send") }
                    }
                }
            }

            ApproveState.Sending -> item { CircularProgressIndicator() }

            ApproveState.Sent -> item { Text("Sent ✓", color = SkColors.BrandBright) }

            is ApproveState.Failed -> {
                item { Text(a.message, color = MaterialTheme.colors.error, textAlign = TextAlign.Center) }
                item {
                    Chip(
                        onClick = vm::onApproveTapped, // back to the confirm step; still requires Send
                        label = { Text("Try again") },
                        colors = ChipDefaults.secondaryChipColors(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}
