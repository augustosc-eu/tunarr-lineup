package io.github.augustosc_eu.tunarrlineup;

import android.content.Context;
import android.content.SharedPreferences;

/** What the app remembers, in its private storage (not backed up: allowBackup is off). */
final class Prefs {
    private static final String FILE = "lineup";

    private Prefs() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** The Lineup server's origin, or null before setup. */
    static String origin(Context context) {
        return prefs(context).getString("origin", null);
    }

    static void setOrigin(Context context, String origin) {
        // A new server means the old sign-in doesn't apply.
        prefs(context).edit().putString("origin", origin).remove("username").remove("password").apply();
    }

    /** The saved sign-in for LINEUP_PASSWORD, or null. */
    static String[] login(Context context) {
        SharedPreferences p = prefs(context);
        String user = p.getString("username", null);
        String password = p.getString("password", null);
        return user == null || password == null ? null : new String[] {user, password};
    }

    static void setLogin(Context context, String user, String password) {
        if (user == null) prefs(context).edit().remove("username").remove("password").apply();
        else prefs(context).edit().putString("username", user).putString("password", password).apply();
    }
}
