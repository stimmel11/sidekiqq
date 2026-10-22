package com.sidekiqq.watch

import android.app.Application
import com.sidekiqq.watch.data.GlanceCache
import com.sidekiqq.watch.data.SideKiqqRepository
import com.sidekiqq.watch.data.WatchPrefs
import com.sidekiqq.watch.notify.Notifier
import com.sidekiqq.watch.tile.GlanceRefreshWorker
import com.sidekiqq.watch.wearable.ReplyBus

/** Hand-wired service locator. The app is small enough not to need a DI framework. */
class SideKiqqApp : Application() {

    lateinit var prefs: WatchPrefs
        private set
    lateinit var repository: SideKiqqRepository
        private set
    lateinit var notifier: Notifier
        private set
    val replyBus = ReplyBus()

    override fun onCreate() {
        super.onCreate()
        prefs = WatchPrefs(this)
        repository = SideKiqqRepository(prefs, GlanceCache(this))
        notifier = Notifier(this).also { it.ensureChannels() }
        GlanceRefreshWorker.schedule(this)
    }
}

val android.content.Context.app: SideKiqqApp get() = applicationContext as SideKiqqApp
