/**
 * PLAN-0631 D31-10: `initials` for a participant, in **one** place.
 *
 * Extracted from `ParticipantRow` (PLAN-0623) so the message identity row and the members
 * panel cannot drift. Two rules carried over verbatim:
 *  - only `displayName` produces letters — **never** the UUID (DEV-032: a principal id is
 *    noise, not a name);
 *  - a nameless participant shows the first letter of the localized "unknown user" label,
 *    so the badge still reads as a person placeholder rather than a fake identity.
 *
 * Deliberately color-free: per-participant hues would be new color values, which this PLAN
 * forbids (distinction comes from the name, the role badge and the icon).
 */
export function participantInitials(
    displayName: string | null | undefined,
    unknownNameLabel: string,
): string {
    const name = displayName?.trim() ?? "";
    if (name) {
        // 纯分隔符/标点词不参与首字母（"Atlas · 架构" ⇒ "A架"，而不是 "A·"）。
        const words = name.split(/\s+/).filter((word) => !/^[\p{P}\p{S}]+$/u.test(word));
        return words
            .slice(0, 2)
            .map((word) => word[0] ?? "")
            .join("")
            .toUpperCase();
    }
    return Array.from(unknownNameLabel)[0]?.toUpperCase() ?? "?";
}

/** The name to print: the real one, or the localized placeholder (never a UUID). */
export function participantDisplayName(
    displayName: string | null | undefined,
    unknownNameLabel: string,
): string {
    return displayName?.trim() || unknownNameLabel;
}
