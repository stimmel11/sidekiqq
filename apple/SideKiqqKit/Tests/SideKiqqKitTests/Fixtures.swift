import Foundation

/**
 * JSON shaped exactly like the brain's responses (brain/src/lib/models.ts and the API routes),
 * including optional fields both present and absent, and extra keys a newer brain might add.
 */
enum Fixtures {
    static let askResponse = #"""
    {"reply":"You promised Dana the revised proposal by Friday. I drafted a short note to her.","spoken":"You owe Dana the revised proposal by Friday. I drafted a note.","conversationId":"c_9f2a","actions":[{"type":"draft_created","id":"dr_1","summary":"Reply to Dana: revised proposal"},{"type":"commitment_added","id":"cm_7","summary":"Send Dana the revised proposal by Friday"}]}
    """#

    static let askResponseNoActions = #"""
    {"reply":"Nothing urgent today.","spoken":"Nothing urgent today.","conversationId":"c_1","actions":[]}
    """#

    static let askResponseFutureAction = #"""
    {"reply":"Started a call.","spoken":"Started.","conversationId":"c_2","actions":[{"type":"video_started","id":"v_1","summary":"Meet with Mike"}],"latencyMs":1200}
    """#

    static let top5 = #"""
    {"items":[{"id":"t1","title":"Send revised proposal to Dana","why":"Promised by Friday; Dana is waiting","importance":"CRITICAL","dueAt":"2026-10-24T17:00:00.000Z"},{"id":"t2","title":"Call Mike about the deposit","why":"Deposit is 5 days late","importance":"HIGH"}],"updatedAt":"2026-10-22T13:00:00.000Z"}
    """#

    static let brief = #"""
    {"kind":"daily","generatedAt":"2026-10-22T12:00:00.000Z","sections":[{"title":"TODAY","items":["10:00 Call with Dana","Proposal due Friday"]},{"title":"MONEY","items":[]}],"top5":[{"id":"t1","title":"Send revised proposal to Dana","why":"Promised by Friday","importance":"CRITICAL"}]}
    """#

    static let followUps = #"""
    {"items":[{"id":"f1","person":"Dana Smith","client":"Acme","reason":"Asked about the proposal 9 days ago","daysQuiet":9,"importance":"HIGH","suggestedMessage":"Hi Dana, the revised proposal is attached.","draftId":"dr_1"},{"id":"f2","person":"Mike","reason":"No next step after the walkthrough","importance":"MEDIUM"}]}
    """#

    static let commitments = #"""
    {"items":[{"id":"cm1","who":"Chris","what":"Send Dana the revised proposal","madeAt":"2026-10-20T15:00:00.000Z","dueAt":"2026-10-24T17:00:00.000Z","dueInferred":false,"status":"open","client":"Acme","project":"Q4 retainer","source":{"kind":"email","ref":"msg_123"},"confidence":"CONFIRMED"},{"id":"cm2","who":"Mike","what":"Send the deposit","madeAt":"2026-10-10T15:00:00.000Z","dueAt":"2026-10-17T17:00:00.000Z","dueInferred":true,"status":"overdue","source":{"kind":"meeting"},"confidence":"INFERRED"}]}
    """#

    static let drafts = #"""
    {"items":[{"id":"dr_1","to":["Dana Smith <dana@acme.com>"],"cc":[],"subject":"Revised proposal","body":"Hi Dana,\n\nThe revised proposal is attached with the updated pricing. Let me know if Friday still works.\n\nChris","client":"Acme","createdAt":"2026-10-22T13:05:00.000Z"},{"id":"dr_2","to":["mike@example.com","sam@example.com"],"cc":["ops@example.com"],"subject":"Deposit","body":"Quick reminder on the deposit.","createdAt":"2026-10-22T13:06:00.000Z"}]}
    """#

    static let alerts = #"""
    {"items":[{"id":"41","at":"2026-10-22T13:10:00.000Z","title":"Dana: proposal?","body":"Dana asked again about the proposal.","kind":"email","importance":"HIGH","priority":"high","client":"Acme","messageId":"m1","threadId":"th1"},{"id":"42","at":"2026-10-22T13:11:00.000Z","title":"Overdue: deposit","body":"Mike's deposit is overdue.","kind":"commitment_overdue","priority":"normal","commitmentId":"cm2"}],"cursor":"42","more":false}
    """#

    static let pair = #"""
    {"token":"sk_dev_abc123","deviceId":"dev_77","device":"phone"}
    """#

    static let ok = #"{"ok":true}"#
    static let transcribe = #"{"text":"what's on my plate today"}"#
    static let error401 = #"{"error":"Invalid or expired pairing code","code":"invalid_code"}"#
    static let error409 = #"{"error":"Draft is sent, not pending","code":"not_pending"}"#

    static func data(_ s: String) -> Data { Data(s.utf8) }
}
