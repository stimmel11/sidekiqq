from sidekiqq_reachy.speech import brief_to_speech, split_for_speech


def test_split_respects_cap_and_sentences():
    text = "One. " * 300
    chunks = split_for_speech(text, 100)
    assert all(len(c) <= 100 for c in chunks)
    assert " ".join(chunks).replace("  ", " ") == text.strip()
    assert split_for_speech("Short reply.") == ["Short reply."]
    assert split_for_speech("   ") == []


def test_split_breaks_a_giant_sentence_on_words():
    chunks = split_for_speech("word " * 500, 120)
    assert all(0 < len(c) <= 120 for c in chunks)
    assert sum(c.count("word") for c in chunks) == 500


def test_brief_to_speech():
    brief = {
        "kind": "daily",
        "sections": [
            {"title": "TODAY", "items": ["10:00 call with Dana", "Proposal due"]},
            {"title": "MONEY", "items": []},
            {"title": "RISKS", "items": ["a", "b", "c", "d", "e"]},
            {"title": "TOP 5 ACTIONS", "items": ["dup"]},
        ],
        "top5": [{"title": "Send ACME proposal.", "why": "", "importance": "HIGH"}, {"title": "Call bank", "why": "", "importance": "MEDIUM"}],
    }
    s = brief_to_speech(brief)
    assert s.startswith("Here's your daily briefing. Your top priorities. First, Send ACME proposal. Second, Call bank.")
    assert "Today: 10:00 call with Dana; Proposal due." in s
    assert "Money" not in s and "dup" not in s
    assert "Risks: a; b; c. Plus 2 more in the app." in s
    long = brief_to_speech({"kind": "weekly", "sections": [{"title": "x", "items": ["y" * 300] * 3}] * 10, "top5": []}, max_chars=500)
    assert len(long) <= 500 and long.endswith("The rest is in the app.")
