package com.sidekiqq.phone.glasses

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Bundle
import androidx.xr.projected.ProjectedContext
import androidx.xr.projected.experimental.ExperimentalProjectedApi
import com.sidekiqq.phone.voice.Speaker

/**
 * The only place outside [ProjectedGlassesBridge] that touches androidx.xr.projected.
 * `src/noxr/.../ProjectedSupport.kt` has the same signatures with no XR dependency, and the
 * Gradle property `sidekiqq.xr` picks which one is compiled (see phone/build.gradle.kts).
 */
@OptIn(ExperimentalProjectedApi::class)
internal object ProjectedSupport {

    /** True when this build includes the Jetpack XR Projected integration. */
    const val COMPILED_IN = true

    /** Returns the projected bridge on Android 16+, or null so the caller falls back. */
    fun createBridge(context: Context, phoneSpeaker: Speaker): GlassesBridge? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
            ProjectedGlassesBridge(context, phoneSpeaker)
        } else {
            null
        }

    /**
     * From an activity running on the glasses, the phone (host) context used to start services.
     * Returns null when unavailable; the caller then uses its application context.
     */
    fun hostContext(activity: Activity): Context? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ProjectedContext.createHostDeviceContext(activity)
        } else {
            null
        }

    /**
     * ActivityOptions bundle that launches an activity on the glasses display, or null below API 35.
     * Throws IllegalStateException when no projected display is connected.
     */
    fun projectedActivityOptions(context: Context): Bundle? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            ProjectedContext.createProjectedActivityOptions(context).toBundle()
        } else {
            null
        }
}
