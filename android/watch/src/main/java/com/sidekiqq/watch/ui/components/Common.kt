package com.sidekiqq.watch.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition

/** Loading, error or data for a screen. */
sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Error(val message: String) : Load<Nothing>
    data class Ready<T>(val data: T) : Load<T>
}

fun Throwable.userMessage(): String = when {
    this is com.sidekiqq.shared.SideKiqqApiException && (status == 401 || status == 403) ->
        "Not paired. Open the phone app."
    this is com.sidekiqq.shared.SideKiqqApiException -> "Brain error ($status)"
    this is java.io.IOException -> "Offline. Check Wi-Fi, LTE or phone."
    else -> message ?: "Something went wrong"
}

/**
 * Standard Wear scaffold: time at top, vignette, position indicator, scaling list.
 *
 * TODO(verify): rotary (bezel/crown) scrolling. wear-compose-foundation 1.3+ adds rotary support
 * to ScalingLazyColumn by default via its rotaryScrollableBehavior parameter. On older versions,
 * add Horologist's rotaryWithScroll() modifier and request focus.
 */
@Composable
fun SkScaffold(
    state: ScalingLazyListState = rememberScalingLazyListState(),
    content: ScalingLazyListScope.() -> Unit,
) {
    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(scalingLazyListState = state) },
    ) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = state,
            verticalArrangement = Arrangement.spacedBy(6.dp),
            content = content,
        )
    }
}

fun ScalingLazyListScope.header(text: String) {
    item { ListHeader { Text(text, color = MaterialTheme.colors.primary) } }
}

fun ScalingLazyListScope.loading() {
    item {
        Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
    }
}

fun ScalingLazyListScope.errorItem(message: String, onRetry: () -> Unit) {
    item {
        Text(
            message,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colors.error,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
        )
    }
    item {
        Chip(
            onClick = onRetry,
            label = { Text("Retry") },
            colors = ChipDefaults.secondaryChipColors(),
        )
    }
}

fun ScalingLazyListScope.emptyItem(message: String) {
    item {
        Text(
            message,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colors.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(16.dp),
        )
    }
}
