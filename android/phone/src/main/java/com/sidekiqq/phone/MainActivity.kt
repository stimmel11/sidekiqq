package com.sidekiqq.phone

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Summarize
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.sidekiqq.phone.glasses.GlassesActivity
import com.sidekiqq.phone.glasses.GlassesSessionService
import com.sidekiqq.phone.handoff.HandoffPlan
import com.sidekiqq.phone.handoff.Handoffs
import com.sidekiqq.phone.medallion.MedallionService
import com.sidekiqq.phone.ui.ApproveDraftDialog
import com.sidekiqq.phone.ui.BriefScreen
import com.sidekiqq.phone.ui.CommitmentsScreen
import com.sidekiqq.phone.ui.FollowUpsScreen
import com.sidekiqq.phone.ui.HandoffDialog
import com.sidekiqq.phone.ui.HomeScreen
import com.sidekiqq.phone.ui.PairingScreen
import com.sidekiqq.phone.ui.SectionCard
import com.sidekiqq.phone.ui.theme.SideKiqqTheme
import com.sidekiqq.phone.voice.AudioCapture
import com.sidekiqq.phone.voice.SpeechInput
import com.sidekiqq.shared.model.Action
import com.sidekiqq.shared.model.CommandResult
import com.sidekiqq.shared.model.FollowUp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val vm: MainViewModel by viewModels()
    private var initialTab by mutableStateOf(Tab.HOME)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        initialTab = tabFrom(intent)
        setContent { SideKiqqTheme { App(vm, initialTab) } }
        // Hand-offs from other devices: poll on open/resume and every 30 s while visible.
        // Delivery is polling only for now (FCM nudge is a later slice).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (isActive) {
                    vm.pollCommands()
                    delay(COMMAND_POLL_MS)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        initialTab = tabFrom(intent)
    }

    private fun tabFrom(i: Intent?) = when (i?.getStringExtra(EXTRA_OPEN_TAB)) {
        "followups" -> Tab.FOLLOWUPS
        "commitments" -> Tab.COMMITMENTS
        "brief" -> Tab.BRIEF
        else -> Tab.HOME
    }

    companion object {
        const val EXTRA_OPEN_TAB = "open_tab"
        private const val COMMAND_POLL_MS = 30_000L
    }
}

enum class Tab(val label: String) { HOME("Home"), FOLLOWUPS("Follow-ups"), COMMITMENTS("Commitments"), BRIEF("Brief") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun App(vm: MainViewModel, requestedTab: Tab) {
    val state by vm.ui.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var tab by rememberSaveable { mutableStateOf(Tab.HOME) }
    LaunchedEffect(requestedTab) { tab = requestedTab }

    var approveFollowUp by remember { mutableStateOf<FollowUp?>(null) }
    var approveAction by remember { mutableStateOf<Action?>(null) }

    // Runtime permissions: notifications + mic + BLE, requested once after pairing.
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }
    LaunchedEffect(state.paired) {
        if (state.paired) {
            val wanted = buildList {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
                add(Manifest.permission.RECORD_AUDIO)
                addAll(MedallionService.requiredPermissions())
            }.filter { ContextCompat.checkSelfPermission(ctx, it) != PackageManager.PERMISSION_GRANTED }
            if (wanted.isNotEmpty()) permLauncher.launch(wanted.toTypedArray())
        }
    }

    LaunchedEffect(state.snackbar, state.error) {
        val msg = state.error ?: state.snackbar
        if (msg != null && state.paired) {
            snackbar.showSnackbar(msg)
            vm.consumeSnackbar()
        }
    }

    if (!state.paired) {
        Scaffold { pad ->
            PairingScreen(state.baseUrl, state.loading, state.error, vm::pair, Modifier.padding(pad))
        }
        return
    }

    val talk: () -> Unit = talk@{
        if (state.talking == TalkState.Speaking) { vm.stopSpeaking(); return@talk }
        if (state.talking != TalkState.Idle) return@talk
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permLauncher.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
            return@talk
        }
        vm.setTalking(TalkState.Listening)
        scope.launch {
            if (SpeechInput.isAvailable(ctx)) {
                vm.ask(SpeechInput.listenOnce(ctx).orEmpty())
            } else {
                // No recognizer on device: record and let the brain transcribe.
                @Suppress("MissingPermission")
                val pcm = runCatching { AudioCapture().recordUtterance() }.getOrDefault(ByteArray(0))
                vm.askFromPcm(pcm)
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("SideKiqq") },
                actions = {
                    IconButton(onClick = vm::refreshAll) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = talk,
                icon = {
                    Icon(
                        if (state.talking == TalkState.Speaking) Icons.Filled.Stop else Icons.Filled.Mic,
                        contentDescription = null,
                    )
                },
                text = {
                    Text(
                        when (state.talking) {
                            TalkState.Idle -> "Talk"
                            TalkState.Listening -> "Listening…"
                            TalkState.Thinking -> "Thinking…"
                            TalkState.Speaking -> "Stop"
                        }
                    )
                },
            )
        },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = {
                            tab = t
                            if (t == Tab.BRIEF && state.brief == null) vm.loadBrief(state.briefKind)
                        },
                        icon = {
                            Icon(
                                when (t) {
                                    Tab.HOME -> Icons.Filled.Home
                                    Tab.FOLLOWUPS -> Icons.AutoMirrored.Filled.Reply
                                    Tab.COMMITMENTS -> Icons.Filled.Checklist
                                    Tab.BRIEF -> Icons.Filled.Summarize
                                },
                                contentDescription = null,
                            )
                        },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { pad ->
        val m = Modifier.padding(pad)
        when (tab) {
            Tab.HOME -> HomeScreen(state, onApproveAnswerDraft = { approveAction = it }, wearables = { WearablesCard(vm) }, modifier = m)
            Tab.FOLLOWUPS -> FollowUpsScreen(state.followUps, onApprove = { approveFollowUp = it }, modifier = m)
            Tab.COMMITMENTS -> CommitmentsScreen(
                state.commitments, state.commitmentFilter, vm::setCommitmentFilter, { vm.completeCommitment(it.id) }, m,
            )
            Tab.BRIEF -> BriefScreen(state, vm::loadBrief, m)
        }
    }

    // ---- The only send paths in the UI, both behind an explicit confirm dialog ----
    approveFollowUp?.let { f ->
        ApproveDraftDialog(
            recipient = f.person,
            message = f.suggestedMessage,
            onConfirm = { vm.approveDraftConfirmed(f); approveFollowUp = null },
            onDismiss = { approveFollowUp = null },
        )
    }
    // ---- Hand-offs: shown one at a time; opened ONLY from the dialog's button ----
    state.handoffs.firstOrNull()?.let { cmd ->
        val plan = Handoffs.planFor(cmd)
        HandoffDialog(
            command = cmd,
            plan = plan,
            onOpen = open@{
                if (!vm.claimHandoff(cmd)) return@open
                val opened = openHandoff(ctx, plan)
                vm.ackHandoff(cmd, if (opened) CommandResult.OPENED else CommandResult.FAILED)
                if (!opened) scope.launch { snackbar.showSnackbar("No app on this phone could open that.") }
            },
            onDismiss = { if (vm.claimHandoff(cmd)) vm.ackHandoff(cmd, CommandResult.DISMISSED) },
        )
    }
    approveAction?.let { a ->
        ApproveDraftDialog(
            recipient = null,
            message = a.summary,
            onConfirm = { vm.approveAnswerDraftConfirmed(a.id, a.summary); approveAction = null },
            onDismiss = { approveAction = null },
        )
    }
}

/**
 * Starts the app for a hand-off plan. Called only from the hand-off dialog's open button.
 * Calls use ACTION_DIAL (the dialer opens pre-filled; the owner still taps Call), never ACTION_CALL.
 * Returns false if nothing could handle it.
 */
private fun openHandoff(ctx: Context, plan: HandoffPlan): Boolean {
    val intent = when (plan) {
        is HandoffPlan.Dial -> Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", plan.number, null))
        is HandoffPlan.WhatsApp -> Intent(Intent.ACTION_VIEW, Uri.parse(plan.url)).addCategory(Intent.CATEGORY_BROWSABLE)
        is HandoffPlan.Browser -> Intent(Intent.ACTION_VIEW, Uri.parse(plan.url)).addCategory(Intent.CATEGORY_BROWSABLE)
        is HandoffPlan.CantOpen -> return false
    }
    return try {
        ctx.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}

@Composable
private fun WearablesCard(vm: MainViewModel) {
    val ctx = LocalContext.current
    val medallion by MedallionService.state.collectAsStateWithLifecycle()
    val glasses by GlassesSessionService.state.collectAsStateWithLifecycle()

    SectionCard(
        title = "Wearables",
        subtitle = buildString {
            append("Medallion: ")
            append(if (!medallion.running) "off" else medallion.phase.name.lowercase())
            medallion.battery?.let { append(" · $it%") }
            append("\nGlasses: ")
            append(
                when {
                    !glasses.running -> "off"
                    glasses.connected -> "${glasses.bridge} · ${glasses.phase.name.lowercase()}"
                    else -> "${glasses.bridge} · not connected"
                }
            )
            medallion.lastAudioWarning?.let { append("\n⚠ $it") }
        },
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (medallion.running) {
                OutlinedButton(onClick = { MedallionService.stop(ctx) }) { Text("Stop medallion") }
            } else {
                Button(onClick = {
                    if (MedallionService.hasBlePermissions(ctx)) MedallionService.start(ctx)
                }) { Text("Connect medallion") }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { GlassesSessionService.wake(ctx) }) { Text("Hey SideKiqq") }
            if (glasses.running) {
                OutlinedButton(onClick = { GlassesSessionService.stop(ctx) }) { Text("Stop glasses") }
            }
            TextButton(onClick = { GlassesActivity.launchOnGlasses(ctx) }) { Text("Open on glasses") }
        }
        TextButton(onClick = vm::unpair) { Text("Unpair this phone") }
    }
}
