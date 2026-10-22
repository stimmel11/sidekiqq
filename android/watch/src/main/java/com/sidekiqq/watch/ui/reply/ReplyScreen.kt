package com.sidekiqq.watch.ui.reply

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.sidekiqq.watch.app
import com.sidekiqq.watch.audio.Speaker
import com.sidekiqq.watch.ui.components.SkScaffold
import com.sidekiqq.watch.ui.components.emptyItem
import com.sidekiqq.watch.ui.components.header
import com.sidekiqq.watch.ui.theme.SkColors

/** Shows the latest answer relayed by the phone (medallion, glasses or phone questions). */
@Composable
fun ReplyScreen() {
    val context = LocalContext.current
    val reply by context.app.replyBus.latest.collectAsState()
    val speaker = remember { Speaker(context) }
    DisposableEffect(Unit) {
        context.app.notifier.cancelReply()
        onDispose { speaker.shutdown() }
    }

    SkScaffold {
        header("Medallion")
        val r = reply
        if (r == null) {
            emptyItem("No medallion reply yet.")
            return@SkScaffold
        }
        r.source?.let { src ->
            item {
                Text(
                    "via $src",
                    color = SkColors.Muted,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                )
            }
        }
        item {
            Text(
                r.spoken,
                style = MaterialTheme.typography.title2,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            )
        }
        if (r.reply != r.spoken) {
            item {
                Text(r.reply, style = MaterialTheme.typography.body2, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp))
            }
        }
        item {
            Chip(
                onClick = { speaker.speak(r.spoken) },
                label = { Text("Read aloud") },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
