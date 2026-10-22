package com.sidekiqq.watch.ui.top5

import android.app.Application
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.sidekiqq.shared.model.Top5Response
import com.sidekiqq.watch.app
import com.sidekiqq.watch.logic.DueFormat
import com.sidekiqq.watch.ui.components.Load
import com.sidekiqq.watch.ui.components.SkScaffold
import com.sidekiqq.watch.ui.components.emptyItem
import com.sidekiqq.watch.ui.components.errorItem
import com.sidekiqq.watch.ui.components.header
import com.sidekiqq.watch.ui.components.loading
import com.sidekiqq.watch.ui.components.userMessage
import com.sidekiqq.watch.ui.theme.SkColors
import com.sidekiqq.watch.ui.theme.importanceColor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId

class Top5ViewModel(application: Application) : AndroidViewModel(application) {
    private val repo = application.app.repository
    private val _state = MutableStateFlow<Load<Top5Response>>(Load.Loading)
    val state = _state.asStateFlow()

    init { refresh() }

    fun refresh() {
        _state.value = Load.Loading
        viewModelScope.launch {
            _state.value = try {
                Load.Ready(repo.top5())
            } catch (e: Exception) {
                Load.Error(e.userMessage())
            }
        }
    }
}

@Composable
fun Top5Screen(vm: Top5ViewModel = viewModel()) {
    val state by vm.state.collectAsState()
    val zone = ZoneId.systemDefault()
    val now = Instant.now()

    SkScaffold {
        header("Top 5")
        when (val s = state) {
            Load.Loading -> loading()
            is Load.Error -> errorItem(s.message, vm::refresh)
            is Load.Ready -> {
                if (s.data.items.isEmpty()) emptyItem("Nothing pressing. Nice.")
                s.data.items.forEachIndexed { i, top ->
                    item {
                        Card(onClick = {}, modifier = Modifier.fillMaxWidth()) {
                            Text(
                                "${i + 1}. ${top.title}",
                                color = importanceColor(top.importance),
                                style = MaterialTheme.typography.title3,
                            )
                            Text(top.why, style = MaterialTheme.typography.body2, color = SkColors.Muted)
                            DueFormat.parse(top.dueAt, zone)?.let { due ->
                                // The TopItem contract has no inferred flag, so show the date as given.
                                val overdue = due.isBefore(now)
                                Text(
                                    DueFormat.label(due, inferred = false, now = now, zone = zone),
                                    color = if (overdue) SkColors.Overdue else SkColors.Muted,
                                    style = MaterialTheme.typography.caption2,
                                )
                            }
                            Text(top.importance.name, color = importanceColor(top.importance), style = MaterialTheme.typography.caption3)
                        }
                    }
                }
            }
        }
    }
}
