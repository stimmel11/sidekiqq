package com.sidekiqq.watch.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import com.sidekiqq.watch.app
import com.sidekiqq.watch.notify.Haptics
import com.sidekiqq.watch.logic.HapticPatterns
import com.sidekiqq.watch.tile.GlanceRefreshWorker
import com.sidekiqq.watch.ui.ask.AskScreen
import com.sidekiqq.watch.ui.commitments.CommitmentsScreen
import com.sidekiqq.watch.ui.followups.FollowUpDetailScreen
import com.sidekiqq.watch.ui.followups.FollowUpsScreen
import com.sidekiqq.watch.ui.reply.ReplyScreen
import com.sidekiqq.watch.ui.settings.SettingsScreen
import com.sidekiqq.watch.ui.theme.SideKiqqTheme
import com.sidekiqq.watch.ui.top5.Top5Screen
import com.sidekiqq.watch.wearable.TokenSync
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    /** A route requested by an intent (notification, tile or complication tap). */
    private val pendingRoute = MutableStateFlow<String?>(null)

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best effort */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        consumeRoute(intent)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        // If the phone already published a token, pick it up.
        lifecycleScope.launch {
            if (TokenSync.pullFromDataLayer(this@MainActivity)) GlanceRefreshWorker.refreshNow(this@MainActivity)
        }

        // Medallion replies that arrive while the app is open go straight to the reply screen.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                app.replyBus.arrivals.collect {
                    Haptics.play(this@MainActivity, HapticPatterns.REPLY)
                    app.notifier.cancelReply()
                    pendingRoute.value = Routes.REPLY
                }
            }
        }

        setContent {
            SideKiqqTheme {
                val nav = rememberSwipeDismissableNavController()
                val route by pendingRoute.collectAsState()

                LaunchedEffect(route) {
                    val r = route ?: return@LaunchedEffect
                    pendingRoute.value = null
                    if (r != Routes.ASK && nav.currentDestination?.route != r) {
                        nav.navigate(r) { launchSingleTop = true }
                    }
                }

                SwipeDismissableNavHost(navController = nav, startDestination = Routes.ASK) {
                    composable(Routes.ASK) { AskScreen(onNavigate = { nav.navigate(it) }) }
                    composable(Routes.TOP5) { Top5Screen() }
                    composable(Routes.FOLLOWUPS) {
                        FollowUpsScreen(onOpen = { id -> nav.navigate(Routes.followUpDetail(id)) })
                    }
                    composable(Routes.FOLLOWUP_DETAIL) { entry ->
                        FollowUpDetailScreen(
                            followUpId = entry.arguments?.getString("id").orEmpty(),
                            onDone = { nav.popBackStack() },
                        )
                    }
                    composable(Routes.COMMITMENTS) { CommitmentsScreen() }
                    composable(Routes.REPLY) { ReplyScreen() }
                    composable(Routes.SETTINGS) { SettingsScreen() }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeRoute(intent)
    }

    private fun consumeRoute(intent: Intent?) {
        val r = intent?.getStringExtra(EXTRA_ROUTE) ?: return
        if (r in Routes.external) pendingRoute.value = r
        intent.removeExtra(EXTRA_ROUTE)
    }

    companion object {
        const val EXTRA_ROUTE = "com.sidekiqq.watch.ROUTE"
    }
}
