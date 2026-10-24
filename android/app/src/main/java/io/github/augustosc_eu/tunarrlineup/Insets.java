package io.github.augustosc_eu.tunarrlineup;

import android.os.Build;
import android.view.View;
import android.view.WindowInsets;

/** Keeps content clear of the status and navigation bars, cutouts and the keyboard (edge-to-edge from Android 11). */
final class Insets {
    private Insets() {}

    static void pad(View root) {
        if (Build.VERSION.SDK_INT < 30) return;
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
        if (root.getContext() instanceof android.app.Activity) {
            ((android.app.Activity) root.getContext()).getWindow().setDecorFitsSystemWindows(false);
        }
    }
}
