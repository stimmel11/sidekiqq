package com.sidekiqq.phone.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import com.sidekiqq.shared.model.Importance

private val Brand = Color(0xFF1F9E6C)
private val BrandDark = Color(0xFF3DDC97)

private val Light = lightColorScheme(primary = Brand, secondary = Color(0xFF3E5C76))
private val Dark = darkColorScheme(primary = BrandDark, secondary = Color(0xFF9DB9D5), background = Color(0xFF0F1115))

@Composable
fun SideKiqqTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val ctx = LocalContext.current
    val scheme = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        dark -> Dark
        else -> Light
    }
    MaterialTheme(colorScheme = scheme, content = content)
}

/** Importance chip colors. Text labels always accompany color (never color alone). */
fun Importance.color(): Color = when (this) {
    Importance.CRITICAL -> Color(0xFFD93025)
    Importance.HIGH -> Color(0xFFE8710A)
    Importance.MEDIUM -> Color(0xFF1A73E8)
    Importance.LOW -> Color(0xFF5F6368)
    Importance.FYI -> Color(0xFF80868B)
}
