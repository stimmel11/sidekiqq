package com.sidekiqq.watch.ui.ask

import android.app.Activity
import android.app.RemoteInput
import android.content.Intent
import androidx.activity.compose.ManagedActivityResultLauncher
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.wear.input.RemoteInputIntentHelper

/**
 * System voice and keyboard input through RemoteInput. Used when RECORD_AUDIO is denied (the
 * system IME owns the mic, not us) and for typed questions or the pairing code.
 */
object RemoteInputVoice {
    const val KEY = "sidekiqq_text"

    fun intent(label: String): Intent {
        val remoteInput = RemoteInput.Builder(KEY).setLabel(label).build()
        return RemoteInputIntentHelper.createActionRemoteInputIntent().also {
            RemoteInputIntentHelper.putRemoteInputsExtra(it, listOf(remoteInput))
        }
    }

    fun read(result: ActivityResult): String? {
        if (result.resultCode != Activity.RESULT_OK) return null
        val data = result.data ?: return null
        return RemoteInput.getResultsFromIntent(data)?.getCharSequence(KEY)?.toString()?.takeIf { it.isNotBlank() }
    }
}

@Composable
fun rememberRemoteInputLauncher(onText: (String) -> Unit): ManagedActivityResultLauncher<Intent, ActivityResult> =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        RemoteInputVoice.read(result)?.let(onText)
    }
