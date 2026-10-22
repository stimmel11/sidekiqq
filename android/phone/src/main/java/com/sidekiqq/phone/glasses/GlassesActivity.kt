package com.sidekiqq.phone.glasses

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/**
 * The SideKiqq entry point that runs ON the glasses (declared with
 * requiredDisplayCategory=XR_PROJECTED + XR_PROJECTED_LAUNCHER in the manifest).
 *
 * Galaxy Glasses are audio-first: this activity is mostly an input surface. A touchpad tap means
 * "Hey SideKiqq". On display glasses it also shows the current phase and the last reply.
 *
 * The voice loop itself lives in GlassesSessionService on the phone; this activity only forwards taps.
 */
class GlassesActivity : ComponentActivity() {

    private var downAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Make sure the phone-side session is running whenever the glasses app is open.
        // A projected activity's context is the glasses' context; services must be started via the host context.
        hostContext().let { host ->
            if (GlassesSessionService.hasMicPermission(host)) GlassesSessionService.start(host)
        }

        // TODO(xr-api): ProjectedDeviceController.create(activity).capabilities.contains(CAPABILITY_VISUAL_UI)
        //   tells audio-only from display glasses. Shown in Google's first-activity sample, but its package and
        //   exact signatures were not verifiable here, so it isn't called. The UI below works on either kind.
        // TODO(xr-api): For display glasses, consider androidx.xr.glimmer (GlimmerTheme, ActionCard) instead of
        //   Material 3. It isn't a dependency yet to keep the alpha surface small.

        setContent { GlassesScreen(onTap = ::wake) }
    }

    /**
     * Touchpad input arrives as generic motion events (ACTION_DOWN / MOVE / UP), per
     * developer.android.com/develop/xr/jetpack-xr-sdk/glasses/physical-input.
     * A short down->up with no long hold is treated as a tap. Long-press (~2 s) is reserved by the
     * system for Gemini, so we never consume long presses.
     */
    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> downAt = SystemClock.uptimeMillis()
            MotionEvent.ACTION_UP -> {
                val held = SystemClock.uptimeMillis() - downAt
                if (downAt != 0L && held < TAP_MAX_MS) {
                    downAt = 0L
                    wake()
                    return true
                }
                downAt = 0L
            }
        }
        return super.dispatchGenericMotionEvent(ev)
    }

    private fun wake() {
        Log.d(TAG, "Glasses tap -> Hey SideKiqq")
        val host = hostContext()
        if (!GlassesSessionService.hasMicPermission(host)) {
            Log.w(TAG, "Mic permission missing; open SideKiqq on the phone to grant it")
            return
        }
        // Going through the service intent (not only the in-process bus) also starts the session if it isn't
        // running yet. The service dedupes overlapping turns.
        GlassesSessionService.wake(host)
    }

    /** Phone-side context. XR specifics live in ProjectedSupport (src/xr, or the src/noxr stub). */
    private fun hostContext(): Context =
        try {
            ProjectedSupport.hostContext(this) ?: applicationContext
        } catch (e: IllegalStateException) {
            applicationContext
        } catch (e: LinkageError) {
            applicationContext
        }

    companion object {
        private const val TAG = "SideKiqqGlassesAct"
        private const val TAP_MAX_MS = 400L

        /**
         * Launches this activity onto the connected glasses from the phone.
         * Uses ProjectedContext.createProjectedActivityOptions (API 35+), as in Google's first-activity guide.
         * @return false if no glasses display is available (or this build has no XR support).
         */
        fun launchOnGlasses(context: Context): Boolean {
            return try {
                val options = ProjectedSupport.projectedActivityOptions(context) ?: return false
                context.startActivity(
                    Intent(context, GlassesActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    options,
                )
                true
            } catch (e: IllegalStateException) {
                Log.w(TAG, "No projected display: ${e.message}")
                false
            } catch (e: LinkageError) {
                Log.w(TAG, "Projected API unavailable on this device", e)
                false
            }
        }
    }
}

@Composable
private fun GlassesScreen(onTap: () -> Unit) {
    val state by GlassesSessionService.state.collectAsStateWithLifecycle()
    MaterialTheme(colorScheme = darkColorScheme(background = Color.Black, surface = Color.Black)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black) // black is transparent on additive displays
                .clickable(onClick = onTap)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            val headline = when (state.phase) {
                GlassesState.Phase.IDLE -> "Tap for SideKiqq"
                GlassesState.Phase.LISTENING -> "Listening…"
                GlassesState.Phase.THINKING -> "Thinking…"
                GlassesState.Phase.SPEAKING -> "Speaking"
                GlassesState.Phase.CONFIRMING -> "Say \"send it\" to confirm"
            }
            Text(headline, color = Color.White, fontSize = 22.sp, textAlign = TextAlign.Center)
            state.lastReply?.let {
                Text(it.take(240), color = Color(0xFFB8F5DA), fontSize = 16.sp, textAlign = TextAlign.Center)
            }
        }
    }
}
