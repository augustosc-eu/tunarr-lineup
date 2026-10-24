package io.github.augustosc_eu.tunarrlineup;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import java.net.HttpURLConnection;
import java.net.URL;

/** Asks for the Lineup server's address and checks that it answers /healthz before saving it. */
public final class SetupActivity extends Activity {
    private EditText address;
    private TextView message;
    private Button connect;
    private Button saveAnyway;
    private String checked;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_setup);
        Insets.pad(findViewById(R.id.setup_root));
        address = findViewById(R.id.address);
        message = findViewById(R.id.message);
        connect = findViewById(R.id.connect);
        saveAnyway = findViewById(R.id.save_anyway);
        String current = Prefs.origin(this);
        if (current != null) address.setText(current);
        address.setOnEditorActionListener((view, action, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_UP;
            if (action != EditorInfo.IME_ACTION_GO && !enter) return false;
            check();
            return true;
        });
        connect.setOnClickListener(view -> check());
        saveAnyway.setOnClickListener(view -> save(checked));
        address.requestFocus();
    }

    private void check() {
        String origin;
        try {
            origin = ServerAddress.normalize(address.getText().toString());
        } catch (IllegalArgumentException error) {
            show(error.getMessage(), false);
            return;
        }
        checked = origin;
        connect.setEnabled(false);
        show(getString(R.string.setup_checking, origin), false);
        new Thread(() -> {
            String problem = reach(origin);
            runOnUiThread(() -> {
                connect.setEnabled(true);
                if (problem == null) save(origin);
                else show(getString(R.string.setup_unreachable, origin, problem), true);
            });
        }).start();
    }

    /** Null when the server answers its health check, otherwise why not. */
    private static String reach(String origin) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin + "/healthz").openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setInstanceFollowRedirects(false);
            int status = connection.getResponseCode();
            return status == 200 ? null : "HTTP " + status;
        } catch (Exception error) {
            return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void show(String text, boolean offerAnyway) {
        message.setText(text);
        message.setVisibility(View.VISIBLE);
        saveAnyway.setVisibility(offerAnyway ? View.VISIBLE : View.GONE);
    }

    private void save(String origin) {
        if (!origin.equals(Prefs.origin(this))) Prefs.setOrigin(this, origin);
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        finish();
    }
}
