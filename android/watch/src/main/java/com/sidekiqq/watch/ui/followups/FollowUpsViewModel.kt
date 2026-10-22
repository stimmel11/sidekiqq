package com.sidekiqq.watch.ui.followups

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.sidekiqq.shared.model.FollowUp
import com.sidekiqq.watch.app
import com.sidekiqq.watch.logic.ApproveFlow
import com.sidekiqq.watch.logic.ApproveState
import com.sidekiqq.watch.tile.GlanceRefreshWorker
import com.sidekiqq.watch.ui.components.Load
import com.sidekiqq.watch.ui.components.userMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Shared by the list and detail screens. The detail screen gets the same activity-scoped
 * instance, so it doesn't need another network round trip.
 */
class FollowUpsViewModel(application: Application) : AndroidViewModel(application) {
    private val repo = application.app.repository

    private val _list = MutableStateFlow<Load<List<FollowUp>>>(Load.Loading)
    val list: StateFlow<Load<List<FollowUp>>> = _list.asStateFlow()

    private val _approve = MutableStateFlow<ApproveState>(ApproveFlow.initial)
    val approve: StateFlow<ApproveState> = _approve.asStateFlow()

    init { refresh() }

    fun refresh() {
        _list.value = Load.Loading
        viewModelScope.launch {
            _list.value = try {
                Load.Ready(repo.followUps())
            } catch (e: Exception) {
                Load.Error(e.userMessage())
            }
        }
    }

    fun find(id: String): FollowUp? = (_list.value as? Load.Ready)?.data?.firstOrNull { it.id == id }

    fun resetApproval() {
        _approve.value = ApproveFlow.initial
    }

    fun onApproveTapped() {
        _approve.value = ApproveFlow.onApproveTapped(_approve.value).state
    }

    fun onCancel() {
        _approve.value = ApproveFlow.onCancel(_approve.value).state
    }

    /**
     * Second, explicit confirmation. approveDraft is called only when the reducer says sendNow,
     * which happens only from the Confirming state.
     */
    fun onConfirmTapped(followUp: FollowUp) {
        val step = ApproveFlow.onConfirmTapped(_approve.value)
        _approve.value = step.state
        if (!step.sendNow) return
        val draftId = followUp.draftId
        if (draftId.isNullOrBlank()) {
            _approve.value = ApproveFlow.onResult(step.state, "No draft to send").state
            return
        }
        viewModelScope.launch {
            val error = try {
                repo.approveDraft(draftId)
                null
            } catch (e: Exception) {
                e.userMessage()
            }
            _approve.value = ApproveFlow.onResult(_approve.value, error).state
            if (error == null) {
                // Drop the sent item locally and refresh the tile and complication counts.
                (_list.value as? Load.Ready)?.let { r -> _list.value = Load.Ready(r.data.filterNot { it.id == followUp.id }) }
                GlanceRefreshWorker.refreshNow(getApplication<Application>())
            }
        }
    }
}
