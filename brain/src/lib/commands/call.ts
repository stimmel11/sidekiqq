import type { Contact, ContactLookup } from "../google/contacts";
import { CommandError, normalizeNumber } from "./index";

/**
 * Number binding for "call <name> on my phone" (task layer slice 2b, docs/CONNECTORS.md §2
 * `device.call`): the number put on a `call_contact` hand-off may come ONLY from
 *
 *  1. a `contacts.lookup` result returned in THIS /api/ask request, and only the single clear match
 *     of a non-ambiguous lookup (`contacts[0]` when `ambiguous` is false), or
 *  2. digits the owner spoke in THIS request (the `/api/ask` `text`, i.e. the owner's transcript).
 *
 * The model never supplies a free-form number: it names a contact id it was handed by
 * lookup_contact (and optionally which of that contact's numbers), or repeats digits that are
 * literally in the owner's words. A number seen in an email, a file, a calendar event or a contact's
 * name/org can't satisfy either rule, so injected text can't put it on the phone. The owner still
 * sees the number on the phone and taps Call in the dialer (ACTION_DIAL): a hand-off, not a call.
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

/**
 * Digit groups in the owner's words, with what separates each from the previous one. Only
 * digits count: "three oh three" is not supported (speech-to-text writes digits for numbers).
 */
function digitGroups(text: string): { plus: boolean; digits: string; joinable: boolean }[] {
  const out: { plus: boolean; digits: string; joinable: boolean }[] = [];
  let last = -1;
  for (const m of text.matchAll(/(\+?)(\d+)/g)) {
    const start = m.index;
    // A group can be joined to the previous one only across number punctuation ("303 555-0142",
    // "(303) 555.0142"), never across words ("303 or 720").
    const between = last < 0 ? "" : text.slice(last, start);
    out.push({ plus: m[1] === "+", digits: m[2]!, joinable: last >= 0 && /^[\s().-]*$/.test(between) && !m[1] });
    last = start + m[0].length;
  }
  return out;
}

/**
 * Numbers the owner said in `text`: every run of consecutive, punctuation-joined digit groups,
 * starting and ending on group boundaries (so "3035550142" can't be cut out of a longer number).
 * Returned normalised: optional leading "+" (only if the owner said it), then digits.
 */
export function spokenNumbers(text: string): Set<string> {
  const groups = digitGroups(text);
  const found = new Set<string>();
  for (let i = 0; i < groups.length; i++) {
    let digits = "";
    for (let j = i; j < groups.length; j++) {
      if (j > i && !groups[j]!.joinable) break;
      digits += groups[j]!.digits;
      if (digits.length > 15) break;
      if (digits.length >= 3) found.add((groups[i]!.plus ? "+" : "") + digits);
    }
  }
  return found;
}

/** Bind the model's choice to a number per the rules above, or throw a CommandError the model can act on. */
export function resolveCallNumber(choice: CallChoice, src: { ownerText: string; lookedUp: LookedUpContacts }): ResolvedCall {
  if ("spokenNumber" in choice) {
    const number = normalizeNumber(choice.spokenNumber);
    const said = spokenNumbers(src.ownerText);
    if (said.has(number)) return { number, via: "spoken" };
    // The owner said "+1 303 …" and the model dropped the "+": use what the owner said.
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
