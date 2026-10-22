package com.sidekiqq.phone.glasses

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * In-process bus from glasses-side input (touchpad tap in [GlassesActivity]) to whichever
 * bridge is active. A tap means "Hey SideKiqq": there is no always-on hotword.
 */
object GlassesWakeBus {
    private val _events = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val events: SharedFlow<Unit> = _events.asSharedFlow()
    fun tap() { _events.tryEmit(Unit) }
}
