import type { Contact, ContactLookup } from "../google/contacts";
import { CommandError, normalizeNumber } from "./index";

/**
 * Number binding for "call <name> on my phone" (task layer slice 2b, docs/CONNECTORS.md §2
 * `device.call`): the number put on a `call_contact` hand-off may come ONLY from
 *
 *  1. a `contacts.lookup` result returned in THIS /api/ask request, and only the single clear match
 *     of a non-ambiguous lookup (`contacts[0]` when `ambiguous` is false) that is a saved contact
 *     (not a Google "Other contact", which Gmail auto-creates from email), or
 *  2. digits the owner spoke in THIS request (the `/api/ask` `text`, i.e. the owner's transcript).
 *
 * The model never supplies a free-form number: it names a contact id it was handed by
 * lookup_contact (and optionally which of that contact's numbers), or repeats digits that are
 * literally in the owner's words. A number seen in an email, a file, a calendar event or a contact's
 * name/org can't satisfy either rule, so injected text can't put it on the phone. The owner still
 * sees the number on the phone and taps Call in the dialer (ACTION_DIAL): a hand-off, not a call.
 *
 * Known gap (bounded by the tap): injected text can still steer WHICH name the model looks up, so
 * a saved contact the owner didn't mean could be put on the phone. The phone shows the name and
 * number, and nothing happens unless the owner taps.
 */

/** Contacts lookup_contact returned in this request, by id. Built by `recordLookup`. */
export type LookedUpContacts = Map<string, { contact: Contact; callable: boolean }>;

/**
 * Remember a lookup's results. Only the top result of a non-ambiguous lookup becomes callable;
 * everything else is "seen" (so the error can say "ask which one" rather than "unknown id").
 * Once callable, an id stays callable for the rest of the request.
 */
export function recordLookup(seen: LookedUpContacts, result: ContactLookup): void {
  result.contacts.forEach((contact, i) => {
    const callable = !result.ambiguous && i === 0;
    const prev = seen.get(contact.id);
    seen.set(contact.id, { contact, callable: callable || (prev?.callable ?? false) });
  });
}

export type CallChoice = { contactId: string; phone?: string | undefined } | { spokenNumber: string };

export interface ResolvedCall {
  number: string;
  /** Display name from the contact (cleaned again by buildCommand). Absent for a spoken number. */
  name?: string;
  via: "contact" | "spoken";
  contactId?: string;
}

/** ISO dates ("2026-10-28") are not numbers: they are replaced by a word before scanning. */
const ISO_DATE = /(?<![\d+])\d{4}-\d{2}-\d{2}(?!\d)/g;
/**
 * A number-like span: optional "+", then digits joined only by number punctuation (spaces, dots,
 * hyphens, en/em dashes, brackets). Words, commas, colons and slashes end a span.
 */
const SPAN = /\+?\d(?:[\s().\-–—]*\d)*/g;
/** "+CC (0) …": the "(0)" is a national trunk prefix, not part of the international number. */
const TRUNK = /^\+(\d{1,3})[\s.\-–—]*\(0\)/;

/**
 * Numbers the owner said in `text`, normalised (a leading "+" only if the owner said it, then
 * digits). Only WHOLE spans count, never a piece of one, so two numbers said back to back
 * ("303 555 0142 720 555 0199") can't be mashed together or split into something else: that span
 * is too long and is refused, and the assistant asks. For an international span the accepted forms
 * are the international one (trunk "(0)" removed: "+44 (0) 20 7946 0958" → "+442079460958") and,
 * when the country code is its own group, the national one ("02079460958"; "+1 303 555 0142" →
 * "3035550142"). Digits spelled as words ("three oh three") are not supported.
 */
export function spokenNumbers(text: string): Set<string> {
  const found = new Set<string>();
  const add = (n: string) => {
    const digits = n.replace(/^\+/, "");
    if (digits.length >= 3 && digits.length <= 15) found.add(n);
  };
  for (const m of text.replace(ISO_DATE, " date ").matchAll(SPAN)) {
    const span = m[0];
    const groups = span.match(/\d+/g) ?? [];
    if (!span.startsWith("+")) {
      add(groups.join(""));
      continue;
    }
    const trunk = TRUNK.exec(span);
    if (trunk) {
      const rest = (span.slice(trunk[0].length).match(/\d+/g) ?? []).join("");
      if (rest) {
        add(`+${trunk[1]}${rest}`);
        add(`0${rest}`);
      }
      continue;
    }
    add(`+${groups.join("")}`);
    if (groups.length > 1 && groups[0]!.length <= 3) add(groups.slice(1).join(""));
  }
  return found;
}

/** Bind the model's choice to a number per the rules above, or throw a CommandError the model can act on. */
export function resolveCallNumber(choice: CallChoice, src: { ownerText: string; lookedUp: LookedUpContacts }): ResolvedCall {
  if ("spokenNumber" in choice) {
    const number = normalizeNumber(choice.spokenNumber);
    const said = spokenNumbers(src.ownerText);
    if (said.has(number)) return { number, via: "spoken" };
    // The owner said "+1 303 …" as one run and the model dropped the "+": use what the owner said.
    if (!number.startsWith("+") && said.has(`+${number}`)) return { number: `+${number}`, via: "spoken" };
    throw new CommandError(
      "That number isn't in what the owner said in this request. Only a looked-up contact or digits the owner spoke can be called; ask the owner for the number.",
      "number_not_spoken",
    );
  }

  const entry = src.lookedUp.get(choice.contactId);
  if (!entry) {
    throw new CommandError("Unknown contactId: call lookup_contact in this request and use an id it returned.", "unknown_contact");
  }
  if (!entry.callable) {
    throw new CommandError(
      "That lookup didn't single out one person. Ask the owner which one they mean (by full name or organisation), then look up that name again. Do not pick one yourself.",
      "ambiguous_contact",
    );
  }
  const { contact } = entry;
  if (contact.source !== "google") {
    throw new CommandError(
      "That match is an address saved automatically from past email, not one of the owner's saved contacts, so it can't be called from here. Ask the owner to say the number.",
      "not_saved_contact",
    );
  }
  if (!contact.phones.length) {
    throw new CommandError(`${contact.name || "That contact"} has no phone number saved. Ask the owner for the number.`, "no_phone");
  }
  let number: string;
  if (choice.phone !== undefined) {
    const wanted = normalizeNumber(choice.phone);
    const match = contact.phones.find((p) => p === wanted);
    if (!match) throw new CommandError("phone must be one of that contact's numbers, exactly as lookup_contact returned it.", "phone_not_on_contact");
    number = match;
  } else if (contact.phones.length === 1) {
    number = contact.phones[0]!;
  } else {
    throw new CommandError(
      `${contact.name || "That contact"} has ${contact.phones.length} numbers. Ask the owner which one, then pass it as phone.`,
      "which_phone",
    );
  }
  return { number, ...(contact.name ? { name: contact.name } : {}), via: "contact", contactId: contact.id };
}
