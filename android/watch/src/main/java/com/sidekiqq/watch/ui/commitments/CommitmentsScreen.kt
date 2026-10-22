package com.sidekiqq.watch.ui.commitments

import android.app.Application
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import kotlin.math.roundToInt
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.sidekiqq.shared.model.Commitment
import com.sidekiqq.shared.model.CommitmentStatus
import com.sidekiqq.watch.app
import com.sidekiqq.watch.logic.DueFormat
import com.sidekiqq.watch.tile.GlanceRefreshWorker
import com.sidekiqq.watch.ui.components.Load
import com.sidekiqq.watch.ui.components.SkScaffold
import com.sidekiqq.watch.ui.components.emptyItem
import com.sidekiqq.watch.ui.components.errorItem
import com.sidekiqq.watch.ui.components.header
import com.sidekiqq.watch.ui.components.loading
import com.sidekiqq.watch.ui.components.userMessage
import com.sidekiqq.watch.ui.theme.SkColors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import androidx.compose.ui.graphics.Color
import java.time.Instant
import java.time.ZoneId

class CommitmentsViewModel(application: Application) : AndroidViewModel(application) {
    private val repo = application.app.repository
    private val _state = MutableStateFlow<Load<List<Commitment>>>(Load.Loading)
    val state = _state.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error = _error.asStateFlow()

    init { refresh() }

    fun refresh() {
        _state.value = Load.Loading
        viewModelScope.launch {
            _state.value = try {
                Load.Ready(sort(repo.openAndOverdue()))
            } catch (e: Exception) {
                Load.Error(e.userMessage())
            }
        }
    }

    /** Hides the item right away, then calls the server and restores it on failure. */
    fun complete(c: Commitment) {
        val before = (_state.value as? Load.Ready)?.data ?: return
        _state.value = Load.Ready(before.filterNot { it.id == c.id })
        viewModelScope.launch {
            try {
                repo.completeCommitment(c.id)
                _error.value = null
                GlanceRefreshWorker.refreshNow(getApplication<Application>())
            } catch (e: Exception) {
                _state.value = Load.Ready(before)
                _error.value = "Couldn't complete: ${e.userMessage()}"
            }
        }
    }

    private fun sort(list: List<Commitment>): List<Commitment> {
        val zone = ZoneId.systemDefault()
        val now = Instant.now()
        // Overdue first, then by due date (no date last).
        return list.sortedWith(
            compareByDescending<Commitment> { DueFormat.isOverdue(it.status, DueFormat.parse(it.dueAt, zone), now) }
                .thenBy { DueFormat.parse(it.dueAt, zone) ?: Instant.MAX },
        )
    }
}

@Composable
fun CommitmentsScreen(vm: CommitmentsViewModel = viewModel()) {
    val state by vm.state.collectAsState()
    val error by vm.error.collectAsState()
    val zone = ZoneId.systemDefault()
    val now = Instant.now()

    SkScaffold {
        header("Commitments")
        error?.let { msg -> item { Text(msg, color = MaterialTheme.colors.error) } }
        when (val s = state) {
            Load.Loading -> loading()
            is Load.Error -> errorItem(s.message, vm::refresh)
            is Load.Ready -> {
                if (s.data.isEmpty()) emptyItem("All clear. No open commitments.")
                else item {
                    Text("Swipe left to complete", color = SkColors.Muted, style = MaterialTheme.typography.caption3)
                }
                s.data.forEach { c ->
                    item(key = c.id) {
                        val due = DueFormat.parse(c.dueAt, zone)
                        val overdue = DueFormat.isOverdue(c.status, due, now)
                        val label = DueFormat.label(due, c.dueInferred, now, zone, overdue = overdue)

                        SwipeToComplete(onComplete = { vm.complete(c) }) {
                            CommitmentCard(c, label, overdue)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CommitmentCard(c: Commitment, dueLabel: String, overdue: Boolean) {
    Card(onClick = {}, modifier = Modifier.fillMaxWidth()) {
        Text(
            c.what,
            style = MaterialTheme.typography.title3,
            color = if (overdue) SkColors.Overdue else MaterialTheme.colors.onSurface,
            maxLines = 3,
        )
        Text(
            listOfNotNull(c.who, c.client).joinToString(" · "),
            color = SkColors.Muted,
            style = MaterialTheme.typography.caption2,
            maxLines = 1,
        )
        Box(Modifier.fillMaxWidth().padding(top = 2.dp), contentAlignment = Alignment.CenterStart) {
            Text(
                dueLabel,
                // Overdue is red. An inferred date stays visibly marked "· inferred", with a
                // distinct tint when it isn't overdue.
                color = when {
                    overdue -> SkColors.Overdue
                    c.dueInferred -> SkColors.Inferred
                    else -> SkColors.Muted
                },
                style = MaterialTheme.typography.caption1,
            )
        }
    }
}

/**
 * Swipe left past [SWIPE_FRACTION] of the width to complete; anything shorter springs back.
 * Built on stable Compose gestures rather than wear-compose's experimental SwipeToReveal, whose API
 * changed between 1.4 and 1.5. A "Complete" accessibility action is exposed for TalkBack.
 */
@Composable
private fun SwipeToComplete(onComplete: () -> Unit, content: @Composable () -> Unit) {
    val offsetX = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val widthPx = remember { floatArrayOf(1f) }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .onSizeChanged { widthPx[0] = it.width.toFloat().coerceAtLeast(1f) }
            .semantics {
                customActions = listOf(CustomAccessibilityAction("Complete") { onComplete(); true })
            },
    ) {
        // Revealed behind the card as it slides.
        Box(
            Modifier.matchParentSize().clip(RoundedCornerShape(24.dp)).background(SkColors.Brand),
            contentAlignment = Alignment.CenterEnd,
        ) {
            Text("Done \u2713", color = Color.White, modifier = Modifier.padding(end = 16.dp))
        }
        Box(
            Modifier
                .offset { IntOffset(offsetX.value.roundToInt(), 0) }
                .pointerInput(Unit) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            scope.launch {
                                if (-offsetX.value > widthPx[0] * SWIPE_FRACTION) {
                                    offsetX.animateTo(-widthPx[0])
                                    onComplete()
                                } else {
                                    offsetX.animateTo(0f)
                                }
                            }
                        },
                        onDragCancel = { scope.launch { offsetX.animateTo(0f) } },
                        onHorizontalDrag = { change, dx ->
                            change.consume()
                            scope.launch { offsetX.snapTo((offsetX.value + dx).coerceIn(-widthPx[0], 0f)) }
                        },
                    )
                },
        ) { content() }
    }
}

private const val SWIPE_FRACTION = 0.4f
