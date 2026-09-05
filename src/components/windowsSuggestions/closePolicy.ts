/**
 * Close policy for the windows-suggestions overlay (GI-free on purpose:
 * testable under plain node).
 *
 * The overlay must re-activate (Main.activateWindow) the last tiled window
 * ONLY when closing is the user's explicit completion of the suggestion
 * flow: a suggestion was picked, the overlay auto-closed because no
 * suggestions remain, or Escape was pressed AFTER a pick (explicit
 * dismissal). Passive closes — key-focus-out, background release,
 * touch-end, or Escape without a pick — are not completion intent.
 *
 * pickedByUser only relaxes Escape: allowing every passive trigger after a
 * single pick would replay the focus-stealing race (key-focus-out → close →
 * activate yanking focus away from the window the user just activated).
 */

export type SuggestionCloseTrigger =
    | 'suggestion-picked'
    | 'no-suggestions'
    | 'key-focus-out'
    | 'background-release'
    | 'escape'
    | 'touch-end';

export function shouldActivateOnClose(
    trigger: SuggestionCloseTrigger,
    pickedByUser: boolean
): boolean {
    return (
        trigger === 'suggestion-picked' ||
        trigger === 'no-suggestions' ||
        (trigger === 'escape' && pickedByUser)
    );
}
