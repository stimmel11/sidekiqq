package com.sidekiqq.watch.tile

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.DimensionBuilders.wrap
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture
import com.sidekiqq.shared.model.Importance
import com.sidekiqq.watch.app
import com.sidekiqq.watch.data.GlanceSnapshot
import com.sidekiqq.watch.ui.MainActivity
import com.sidekiqq.watch.ui.Routes
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.guava.future
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Tile: top 3 actions, colored by importance, plus a red count of overdue commitments.
 * Tapping anywhere opens the app on the Top 5 screen.
 *
 * Built with plain protolayout rather than protolayout-material so there's one fewer
 * dependency. Swap in PrimaryLayout later if the design wants it.
 */
class SideKiqqTileService : TileService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> =
        scope.future {
            val repo = applicationContext.app.repository
            // Fetch fresh data if it's quick; otherwise render the cache. Tile requests are time-boxed.
            val snapshot = if (repo.isPaired) {
                withTimeoutOrNull(FETCH_TIMEOUT_MS) { runCatching { repo.refreshGlance() }.getOrNull() }
                    ?: repo.cachedGlance()
            } else {
                null
            }
            TileBuilders.Tile.Builder()
                .setResourcesVersion(RESOURCES_VERSION)
                .setFreshnessIntervalMillis(FRESHNESS_MS)
                .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout(snapshot)))
                .build()
        }

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> =
        // Uses scope.future instead of Guava's Futures, so full Guava isn't needed directly (tiles ships only listenablefuture).
        scope.future { ResourceBuilders.Resources.Builder().setVersion(RESOURCES_VERSION).build() }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }

    private fun layout(s: GlanceSnapshot?): LayoutElementBuilders.LayoutElement {
        val column = LayoutElementBuilders.Column.Builder()
            .setWidth(expand())
            .setHeight(wrap())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(text("SideKiqq", 12f, GREY, bold = false))
            .addContent(spacer(6f))

        when {
            s == null -> column.addContent(text("Open app to pair", 14f, WHITE, maxLines = 2))
            s.top.isEmpty() && s.fetchedAtMs == 0L -> column.addContent(text("Loading…", 14f, WHITE))
            s.top.isEmpty() -> column.addContent(text("Nothing urgent", 14f, WHITE))
            else -> s.top.take(3).forEachIndexed { i, item ->
                column.addContent(
                    text("${i + 1}. ${item.title}", 14f, colorFor(item.importance), bold = i == 0),
                )
                column.addContent(spacer(2f))
            }
        }

        if (s != null && s.overdueCount >= 0) {
            column.addContent(spacer(6f))
            column.addContent(
                if (s.overdueCount > 0) text("${s.overdueCount} overdue", 13f, RED, bold = true)
                else text("0 overdue", 13f, GREEN),
            )
        }

        return LayoutElementBuilders.Box.Builder()
            .setWidth(expand())
            .setHeight(expand())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
            .setModifiers(
                ModifiersBuilders.Modifiers.Builder()
                    .setClickable(openAppClickable())
                    .setPadding(ModifiersBuilders.Padding.Builder().setAll(dp(PADDING_DP)).build())
                    .build(),
            )
            .addContent(column.build())
            .build()
    }

    private fun openAppClickable(): ModifiersBuilders.Clickable {
        // TODO(verify): AndroidActivity.addKeyToExtraMapping + AndroidStringExtra deliver the route
        // as a normal String extra, as protolayout docs describe. If not, MainActivity still opens
        // on the Ask screen.
        val activity = ActionBuilders.AndroidActivity.Builder()
            .setPackageName(packageName)
            .setClassName(MainActivity::class.java.name)
            .addKeyToExtraMapping(
                MainActivity.EXTRA_ROUTE,
                ActionBuilders.AndroidStringExtra.Builder().setValue(Routes.TOP5).build(),
            )
            .build()
        return ModifiersBuilders.Clickable.Builder()
            .setId("open_app")
            .setOnClick(ActionBuilders.LaunchAction.Builder().setAndroidActivity(activity).build())
            .build()
    }

    private fun text(
        value: String,
        sizeSp: Float,
        color: Int,
        bold: Boolean = false,
        maxLines: Int = 1,
    ): LayoutElementBuilders.LayoutElement =
        LayoutElementBuilders.Text.Builder()
            .setText(value)
            .setMaxLines(maxLines)
            .setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE_END)
            .setFontStyle(
                LayoutElementBuilders.FontStyle.Builder()
                    .setSize(sp(sizeSp))
                    .setColor(argb(color))
                    .setWeight(
                        if (bold) LayoutElementBuilders.FONT_WEIGHT_BOLD else LayoutElementBuilders.FONT_WEIGHT_NORMAL,
                    )
                    .build(),
            )
            .build()

    private fun spacer(heightDp: Float): LayoutElementBuilders.LayoutElement =
        LayoutElementBuilders.Spacer.Builder().setHeight(dp(heightDp)).build()

    companion object {
        private const val RESOURCES_VERSION = "1"
        private const val FRESHNESS_MS = 30L * 60L * 1000L
        private const val FETCH_TIMEOUT_MS = 6_000L
        private const val PADDING_DP = 18f

        private const val WHITE = 0xFFFFFFFF.toInt()
        private const val GREY = 0xFFAAAAAA.toInt()
        private const val RED = 0xFFFF5252.toInt()
        private const val ORANGE = 0xFFFFB74D.toInt()
        private const val GREEN = 0xFF81C784.toInt()

        fun colorFor(importance: Importance): Int = when (importance) {
            Importance.CRITICAL -> RED
            Importance.HIGH -> ORANGE
            else -> WHITE
        }
    }
}
