---
# HOME PAGE COPY. Every word on the home page lives in this file (except the
# waitlist box and header/footer, which live in src/content/site.json, and the
# FAQ answers, which live in src/content/faq/). Edit text between the quotes.
# All names and companies in the samples below are fictional.

title: "SideKiqq — It goes where you go"
description: "SideKiqq reads your email and calendar, tracks every commitment, tells you who to follow up with, and never sends a word without your approval."

hero:
  headline: "It goes where you go."
  subhead: "SideKiqq reads your email and calendar, keeps track of every promise made in them, and tells you who needs an answer. It drafts the reply. You decide whether it goes."
  primaryCta: { label: "Join the waitlist", href: "#waitlist" }
  secondaryCta: { label: "See how it works", href: "#how-it-works" }
  sample:
    from: "Dana Reyes, Harbor & Pine"
    subject: "Re: Spring rollout"
    received: "Mon 9:42"
    quote: "Thanks for the call. You mentioned revised pricing by Wednesday. Our board meets Thursday morning."
    commitment:
      who: "You"
      what: "Send revised pricing"
      due: "Wed, Oct 28"
      client: "Harbor & Pine"
    draft:
      to: "Dana Reyes"
      body: "Dana, revised pricing attached, ahead of Thursday. Happy to walk the board through it if useful."

howItWorks:
  heading: "From inbox to handled, without losing the thread"
  intro: "One email, followed through every step SideKiqq takes with it. The last step is always yours."
  steps:
    - title: "An email arrives"
      body: "SideKiqq reads new mail as it lands in your inbox."
      sample: "From Dana Reyes\nRe: Spring rollout"
    - title: "It's understood"
      body: "It works out what kind of message this is and how much it matters, and keeps important separate from urgent."
      sample: "Existing client, Pricing\nImportance: HIGH"
    - title: "It's linked to the client"
      body: "The message joins the client's timeline, next to past emails, meetings, and decisions."
      sample: "Harbor & Pine\n14 emails, last call Oct 14"
    - title: "Commitments are found"
      body: "Every promise is pulled out: who made it, what it was, and when it's due. A guessed date is labelled as a guess."
      sample: "You: revised pricing\nDue Wed, confirmed"
    - title: "The follow-up is surfaced"
      body: "Before the date slips, it tells you, on whatever device is closest, with a reply already drafted."
      sample: "Tue 8:00\nPricing for Dana due tomorrow"
    - title: "You approve"
      body: "Read the draft, change it, or drop it. Nothing is sent until you say so."
      sample: "Draft ready\nWaiting for you"

devices:
  heading: "One brain. Wherever your hands are."
  intro: "Every device is a window onto the same assistant in the cloud. Ask on your watch, hear the answer in your glasses, approve on your phone."
  link: { label: "More about the devices", href: "/devices" }

trust:
  heading: "It never sends without you."
  body: "SideKiqq can read, sort, remember, and draft. It cannot send. Every message it writes waits as a draft until you approve it, on a screen or out loud with a second confirmation."
  points:
    - title: "Drafts, not sends"
      body: "There is exactly one way a message leaves SideKiqq: you approve that specific draft."
    - title: "Guesses are labelled"
      body: "If a due date or fact is inferred rather than stated, SideKiqq says so, in writing and out loud."
    - title: "Clients stay separate"
      body: "One client's details never show up in a reply about another."
  link: { label: "What SideKiqq touches, and what it doesn't", href: "/privacy-and-trust" }

brief:
  heading: "Your morning, already sorted"
  intro: "Each morning SideKiqq writes a short brief: what's on today, who's waiting on you, what's at risk, and the five things that matter most."
  disclaimer: "Sample brief. Every name, company, and number in it is fictional."
  sample:
    date: "Tuesday, October 27"
    sections:
      - title: "Today"
        items:
          - "10:00 Site walk with Okafor Builders"
          - "2:30 Call with Lena Marsh, Fieldstone Advisory"
      - title: "Waiting on you"
        items:
          - "Dana Reyes (Harbor & Pine): revised pricing, due tomorrow"
          - "Sam Ito asked for the venue contract Friday. No reply yet."
      - title: "Waiting on others"
        items:
          - "Okafor Builders: deposit promised by Monday, not received"
      - title: "Risks"
        items:
          - "Fieldstone has gone quiet for 11 days after asking for a proposal"
    top5:
      - title: "Send Harbor & Pine revised pricing"
        why: "You promised Wednesday; their board meets Thursday."
        importance: HIGH
      - title: "Reply to Sam Ito about the venue contract"
        why: "Unanswered since Friday."
        importance: HIGH
      - title: "Check in with Fieldstone"
        why: "Proposal requested, then 11 days of silence."
        importance: MEDIUM
      - title: "Ask Okafor about the deposit"
        why: "Promised Monday. Ask at today's site walk."
        importance: MEDIUM
      - title: "Confirm Thursday's dinner booking"
        why: "Due date inferred from Lena's email."
        importance: LOW

faq:
  heading: "Questions"
---
