package com.sidekiqq.watch.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme
import com.sidekiqq.shared.model.Importance

object SkColors {
    val Brand = Color(0xFF2E7D32)
    val BrandBright = Color(0xFF66BB6A)
    val Recording = Color(0xFFE53935)
    val Overdue = Color(0xFFFF5252)
    val High = Color(0xFFFFB74D)
    val Inferred = Color(0xFFB0BEC5)
    val Muted = Color(0xFFAAAAAA)
}

fun importanceColor(i: Importance): Color = when (i) {
    Importance.CRITICAL -> SkColors.Overdue
    Importance.HIGH -> SkColors.High
    Importance.MEDIUM -> Color.White
    Importance.LOW, Importance.FYI -> SkColors.Muted
}

private val colors = Colors(
    primary = SkColors.BrandBright,
    primaryVariant = SkColors.Brand,
    secondary = SkColors.High,
    error = SkColors.Overdue,
)

@Composable
fun SideKiqqTheme(content: @Composable () -> Unit) {
    MaterialTheme(colors = colors, content = content)
}
