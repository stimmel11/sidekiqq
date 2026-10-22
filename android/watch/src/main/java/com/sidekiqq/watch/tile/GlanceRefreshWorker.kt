package com.sidekiqq.watch.tile

import android.content.ComponentName
import android.content.Context
import android.util.Log
import androidx.wear.tiles.TileService
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.sidekiqq.watch.app
import com.sidekiqq.watch.complication.FollowUpComplicationService
import java.util.concurrent.TimeUnit

/**
 * Every 30 minutes, refreshes the glance cache (top 3, overdue count, follow-up count) and asks
 * the tile and complication to re-render. The tile also sets freshnessIntervalMillis = 30 min as
 * a second trigger, because WorkManager may be deferred in deep Doze.
 */
class GlanceRefreshWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext.app
        if (!app.repository.isPaired) return Result.success()
        return try {
            app.repository.refreshGlance()
            requestSurfaceUpdates(applicationContext)
            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "Glance refresh failed", e)
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }

    companion object {
        private const val TAG = "GlanceRefresh"
        private const val PERIODIC = "sidekiqq_glance_periodic"
        private const val ONESHOT = "sidekiqq_glance_now"

        private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<GlanceRefreshWorker>(30, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun refreshNow(context: Context) {
            val req = OneTimeWorkRequestBuilder<GlanceRefreshWorker>().setConstraints(constraints).build()
            WorkManager.getInstance(context).enqueueUniqueWork(ONESHOT, ExistingWorkPolicy.REPLACE, req)
        }

        /** Re-renders the tile and complication from the cache. No network. */
        fun requestSurfaceUpdates(context: Context) {
            TileService.getUpdater(context).requestUpdate(SideKiqqTileService::class.java)
            ComplicationDataSourceUpdateRequester
                .create(context, ComponentName(context, FollowUpComplicationService::class.java))
                .requestUpdateAll()
        }
    }
}
