package com.sidekiqq.watch.logic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApproveFlowTest {

    @Test fun singleApproveTapNeverSends() {
        val step = ApproveFlow.onApproveTapped(ApproveFlow.initial)
        assertEquals(ApproveState.Confirming, step.state)
        assertFalse(step.sendNow)
    }

    @Test fun confirmFromReviewingDoesNothing() {
        // Skipping the Approve step must not send.
        val step = ApproveFlow.onConfirmTapped(ApproveState.Reviewing)
        assertEquals(ApproveState.Reviewing, step.state)
        assertFalse(step.sendNow)
    }

    @Test fun approveThenConfirmSendsExactlyOnce() {
        val s1 = ApproveFlow.onApproveTapped(ApproveFlow.initial).state
        val s2 = ApproveFlow.onConfirmTapped(s1)
        assertTrue(s2.sendNow)
        assertEquals(ApproveState.Sending, s2.state)
        // A double tap while sending must not send again.
        val s3 = ApproveFlow.onConfirmTapped(s2.state)
        assertFalse(s3.sendNow)
        assertEquals(ApproveState.Sending, s3.state)
    }

    @Test fun cancelReturnsToReviewing() {
        val s = ApproveFlow.onCancel(ApproveState.Confirming)
        assertEquals(ApproveState.Reviewing, s.state)
        assertFalse(s.sendNow)
    }

    @Test fun resultTransitions() {
        assertEquals(ApproveState.Sent, ApproveFlow.onResult(ApproveState.Sending, null).state)
        assertEquals(ApproveState.Failed("boom"), ApproveFlow.onResult(ApproveState.Sending, "boom").state)
        // A late result for a screen that already moved on is ignored.
        assertEquals(ApproveState.Reviewing, ApproveFlow.onResult(ApproveState.Reviewing, null).state)
    }

    @Test fun retryAfterFailureStillRequiresConfirm() {
        val retry = ApproveFlow.onApproveTapped(ApproveState.Failed("x"))
        assertEquals(ApproveState.Confirming, retry.state)
        assertFalse(retry.sendNow)
    }

    @Test fun sentIsTerminal() {
        assertFalse(ApproveFlow.onApproveTapped(ApproveState.Sent).sendNow)
        assertFalse(ApproveFlow.onConfirmTapped(ApproveState.Sent).sendNow)
    }

    @Test fun confirmPromptNamesPerson() {
        assertEquals("Send to Dana?", ApproveFlow.confirmPrompt("Dana"))
        assertEquals("Send to this person?", ApproveFlow.confirmPrompt("  "))
    }
}
