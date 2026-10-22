package com.sidekiqq.phone.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sidekiqq.phone.UiState
import com.sidekiqq.shared.model.Action
import com.sidekiqq.shared.model.ActionType
import com.sidekiqq.shared.model.BriefKind
import com.sidekiqq.shared.model.Commitment
import com.sidekiqq.shared.model.CommitmentStatus
import com.sidekiqq.shared.model.Confidence
import com.sidekiqq.shared.model.FollowUp

private val listPadding = PaddingValues(16.dp)

@Composable
fun HomeScreen(
    state: UiState,
    onApproveAnswerDraft: (Action) -> Unit,
    wearables: @Composable () -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(modifier.fillMaxSize(), contentPadding = listPadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        state.lastAnswer?.let { a ->
            item {
                SectionCard(title = state.lastQuestion ?: "SideKiqq", subtitle = a.reply) {
                    a.actions.forEach { act ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(act.summary, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                            if (act.type == ActionType.DRAFT_CREATED) {
                                TextButton(onClick = { onApproveAnswerDraft(act) }) { Text("Review & send") }
                            }
                        }
                    }
                }
            }
        }
        item { Text("Top 5", style = MaterialTheme.typography.titleLarge) }
        val topItems = state.top5?.items.orEmpty()
        if (topItems.isEmpty()) item { Text(if (state.loading) "Loading…" else "Nothing ranked yet.") }
        items(topItems, key = { it.id }) { t ->
            SectionCard(
                title = t.title,
                subtitle = listOfNotNull(t.why, t.dueAt?.let { "Due $it" }).joinToString(" · "),
                importance = t.importance,
            )
        }
        item { wearables() }
    }
}

@Composable
fun FollowUpsScreen(
    followUps: List<FollowUp>,
    onApprove: (FollowUp) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(modifier.fillMaxSize(), contentPadding = listPadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (followUps.isEmpty()) item { Text("No follow-ups recommended right now.") }
        items(followUps, key = { it.id }) { f ->
            SectionCard(
                title = f.person + (f.client?.let { " · $it" } ?: ""),
                subtitle = f.reason + (f.daysQuiet?.let { " ($it days quiet)" } ?: ""),
                importance = f.importance,
            ) {
                f.suggestedMessage?.let {
                    Text("Suggested: $it", style = MaterialTheme.typography.bodySmall)
                }
                if (f.draftId != null) {
                    Button(onClick = { onApprove(f) }) { Text("Review & send draft") }
                } else {
                    Text("Follow-up recommended. No draft yet.", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
fun CommitmentsScreen(
    commitments: List<Commitment>,
    filter: CommitmentStatus,
    onFilter: (CommitmentStatus) -> Unit,
    onDone: (Commitment) -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirmDone by remember { mutableStateOf<Commitment?>(null) }
    Column(modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(CommitmentStatus.OPEN, CommitmentStatus.OVERDUE, CommitmentStatus.ALL).forEach { s ->
                FilterChip(selected = filter == s, onClick = { onFilter(s) }, label = { Text(s.wire.replaceFirstChar { it.titlecase() }) })
            }
        }
        LazyColumn(contentPadding = listPadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (commitments.isEmpty()) item { Text("Nothing here.") }
            items(commitments, key = { it.id }) { c ->
                SectionCard(
                    title = c.what,
                    subtitle = buildString {
                        append(c.who)
                        c.client?.let { append(" · $it") }
                        c.dueAt?.let { append(" · due $it") }
                        append(" · ${c.status.wire}")
                    },
                    trailing = {
                        if (c.status != CommitmentStatus.DONE) {
                            OutlinedButton(onClick = { confirmDone = c }) { Text("Done") }
                        }
                    },
                ) {
                    if (c.dueInferred || c.confidence == Confidence.INFERRED) InferredTag()
                }
            }
        }
    }
    confirmDone?.let { c ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmDone = null },
            title = { Text("Mark done?") },
            text = { Text(c.what) },
            confirmButton = { Button(onClick = { onDone(c); confirmDone = null }) { Text("Mark done") } },
            dismissButton = { TextButton(onClick = { confirmDone = null }) { Text("Cancel") } },
        )
    }
}

@Composable
fun BriefScreen(
    state: UiState,
    onLoad: (BriefKind) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(BriefKind.DAILY to "Daily", BriefKind.EOD to "End of day", BriefKind.WEEKLY to "Weekly").forEach { (k, label) ->
                FilterChip(selected = state.briefKind == k, onClick = { onLoad(k) }, label = { Text(label) })
            }
        }
        val b = state.brief
        LazyColumn(contentPadding = listPadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (b == null) {
                item {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(if (state.loading) "Generating…" else "No brief loaded.")
                        if (!state.loading) Button(onClick = { onLoad(state.briefKind) }) { Text("Generate") }
                    }
                }
            } else {
                item { Text("Generated ${b.generatedAt}", style = MaterialTheme.typography.labelSmall) }
                items(b.sections) { s ->
                    SectionCard(title = s.title) {
                        s.items.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
                    }
                }
                if (b.top5.isNotEmpty()) {
                    item { Text("Top 5 actions", style = MaterialTheme.typography.titleMedium) }
                    items(b.top5) { t ->
                        SectionCard(title = t.title, subtitle = t.why, importance = t.importance)
                    }
                }
            }
        }
    }
}
