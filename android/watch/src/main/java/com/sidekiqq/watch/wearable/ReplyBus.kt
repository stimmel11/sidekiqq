package com.sidekiqq.watch.wearable

import com.sidekiqq.watch.logic.ReplyPayload
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/** In-process hand-off of medallion replies from PhoneListenerService to the UI. */
class ReplyBus {
    private val _latest = MutableStateFlow<ReplyPayload?>(null)

    /** The most recent reply, shown by the reply screen. */
    val latest: StateFlow<ReplyPayload?> = _latest.asStateFlow()

    private val _arrivals = MutableSharedFlow<ReplyPayload>(extraBufferCapacity = 4)

    /** Fires once per new reply. MainActivity navigates to the reply screen if it's in the foreground. */
    val arrivals: SharedFlow<ReplyPayload> = _arrivals.asSharedFlow()

    fun publish(reply: ReplyPayload) {
        _latest.value = reply
        _arrivals.tryEmit(reply)
    }
}
