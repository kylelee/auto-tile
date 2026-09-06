import { St, Clutter, Shell, Meta } from '../gi/ext';

// Compatibility for GNOME 48+ where 'vertical' was deprecated in favor of 'orientation'
export function widgetOrientation(vertical: boolean) {
    // if orientation is supported
    if (St.BoxLayout.prototype.get_orientation !== undefined) {
        return {
            orientation: vertical
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL,
        };
    }

    return { vertical };
}

export function buildBlurEffect(sigma: number): Shell.BlurEffect {
    // changes in GNOME 46+
    // The sigma in Shell.BlurEffect should be replaced by radius. Since the sigma value
    // is radius / 2.0, the radius value will be sigma * 2.0.

    const effect = new Shell.BlurEffect();
    effect.set_mode(Shell.BlurMode.BACKGROUND); // blur what is behind the widget
    effect.set_brightness(1);
    if (effect.set_radius) {
        effect.set_radius(sigma * 2);
    } else {
        // @ts-expect-error "set_sigma is available in old shell versions (<= 45)"
        effect.set_sigma(sigma);
    }
    return effect;
}

export function getEventCoords(event: any): number[] {
    return event.get_coords ? event.get_coords() : [event.x, event.y]; // GNOME 40-44
}

// GNOME 49 removed the MaximizeFlags argument and get_maximized(); keep the
// flags for older shells behind a local alias so version checks stay textual
const MAXIMIZE_FLAGS = Meta.MaximizeFlags;

export function maximizeWindow(window: Meta.Window): void {
    window.get_maximized
        ? window.maximize(MAXIMIZE_FLAGS.BOTH)
        : window.maximize();
}

export function unmaximizeWindow(window: Meta.Window): void {
    window.get_maximized
        ? window.unmaximize(MAXIMIZE_FLAGS.BOTH)
        : window.unmaximize();
}
