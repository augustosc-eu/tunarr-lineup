package io.github.augustosc_eu.tunarrlineup;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.HttpAuthHandler;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * The desk in a full-screen WebView of the saved Lineup server (D60). The page
 * is the companion's own, so it still calls only same-origin /api/tunarr/*.
 * The window never leaves that origin, exposes no JavaScript bridge and reads
 * no local files. Back and the remote's keys reach the desk as it expects
 * (invariant 8): Back is Escape, CH± are PageUp/PageDown.
 */
public final class MainActivity extends Activity {
    static final String ACTION_CHANGE_SERVER = "io.github.augustosc_eu.tunarrlineup.CHANGE_SERVER";
    private static final int PICK_FILE = 1;

    private String origin;
    private FrameLayout root;
    private WebView web;
    private View error;
    private TextView errorText;
    private ValueCallback<Uri[]> pickedFiles;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenDone;
    private boolean usedSavedLogin;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        origin = Prefs.origin(this);
        if (origin == null || ACTION_CHANGE_SERVER.equals(getIntent().getAction())) {
            changeServer();
            return;
        }
        setContentView(R.layout.activity_main);
        root = findViewById(R.id.root);
        web = findViewById(R.id.web);
        error = findViewById(R.id.error);
        errorText = findViewById(R.id.error_text);
        Insets.pad(root);
        ((Button) findViewById(R.id.retry)).setOnClickListener(view -> load());
        ((Button) findViewById(R.id.change_server)).setOnClickListener(view -> changeServer());
        setUpWeb();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }
        if (state == null || web.restoreState(state) == null) load();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (ACTION_CHANGE_SERVER.equals(intent.getAction())) changeServer();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if (web != null) web.saveState(state);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setUpWeb() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // drafts (IndexedDB) and the skin (localStorage)
        settings.setMediaPlaybackRequiresUserGesture(false); // Watch Live starts when tuned
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebViewClient(new LineupClient());
        web.setWebChromeClient(new LineupChrome());
        // Exports are blob: downloads, which a WebView can't save.
        web.setDownloadListener((url, agent, disposition, mime, length) ->
                Toast.makeText(this, R.string.no_downloads, Toast.LENGTH_LONG).show());
    }

    private void load() {
        error.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(origin + "/");
        web.requestFocus();
    }

    private void changeServer() {
        startActivity(new Intent(this, SetupActivity.class));
        finish();
    }

    /** Back closes what's open on the desk, as Escape does; on the error screen it leaves the app. */
    private void back() {
        if (fullscreen != null) {
            leaveFullscreen();
        } else if (web == null || error.getVisibility() == View.VISIBLE) {
            finish();
        } else {
            sendKey(KeyEvent.KEYCODE_ESCAPE);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        back(); // Android 12 and earlier; newer versions use the callback above
    }

    private void sendKey(int code) {
        web.requestFocus();
        web.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, code));
        web.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, code));
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (web != null && (code == KeyEvent.KEYCODE_CHANNEL_UP || code == KeyEvent.KEYCODE_CHANNEL_DOWN)) {
            int page = code == KeyEvent.KEYCODE_CHANNEL_UP ? KeyEvent.KEYCODE_PAGE_UP : KeyEvent.KEYCODE_PAGE_DOWN;
            web.requestFocus();
            web.dispatchKeyEvent(new KeyEvent(event.getDownTime(), event.getEventTime(), event.getAction(), page, event.getRepeatCount()));
            return true;
        }
        if (code == KeyEvent.KEYCODE_MENU) {
            if (event.getAction() == KeyEvent.ACTION_UP) showOptions();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    /** The remote's Menu key: the app's own commands, beside the desk's menus. */
    private void showOptions() {
        String[] items = {getString(R.string.reload), getString(R.string.change_server), getString(R.string.quit)};
        new AlertDialog.Builder(this).setTitle(origin).setItems(items, (dialog, which) -> {
            if (which == 0) load();
            else if (which == 1) changeServer();
            else finish();
        }).show();
    }

    private void showError(CharSequence description) {
        errorText.setText(getString(R.string.error_unreachable, origin, description));
        web.setVisibility(View.GONE);
        error.setVisibility(View.VISIBLE);
        findViewById(R.id.retry).requestFocus();
    }

    private void openOutside(Uri url) {
        String scheme = url.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException ignored) {
            Toast.makeText(this, url.toString(), Toast.LENGTH_LONG).show();
        }
    }

    private void askForLogin(HttpAuthHandler handler) {
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(pad, pad / 2, pad, 0);
        EditText user = new EditText(this);
        user.setHint(R.string.username);
        user.setSingleLine(true);
        String[] saved = Prefs.login(this);
        user.setText(saved == null ? "lineup" : saved[0]);
        EditText password = new EditText(this);
        password.setHint(R.string.password);
        password.setSingleLine(true);
        password.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        CheckBox remember = new CheckBox(this);
        remember.setText(R.string.remember_login);
        remember.setChecked(true);
        form.addView(user);
        form.addView(password);
        form.addView(remember);
        new AlertDialog.Builder(this)
                .setTitle(R.string.sign_in)
                .setView(form)
                .setPositiveButton(R.string.sign_in, (dialog, which) -> {
                    String name = user.getText().toString();
                    String secret = password.getText().toString();
                    Prefs.setLogin(this, remember.isChecked() ? name : null, secret);
                    handler.proceed(name, secret);
                })
                .setNegativeButton(android.R.string.cancel, (dialog, which) -> handler.cancel())
                .setOnCancelListener(dialog -> handler.cancel())
                .show();
        password.requestFocus();
    }

    private void leaveFullscreen() {
        if (fullscreen == null) return;
        root.removeView(fullscreen);
        fullscreen = null;
        web.setVisibility(View.VISIBLE);
        if (fullscreenDone != null) fullscreenDone.onCustomViewHidden();
        fullscreenDone = null;
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == PICK_FILE && pickedFiles != null) {
            pickedFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            pickedFiles = null;
            return;
        }
        super.onActivityResult(request, result, data);
    }

    private final class LineupClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (ServerAddress.isSameOrigin(origin, url.toString())) return false;
            openOutside(url);
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError failure) {
            if (request.isForMainFrame()) showError(failure.getDescription());
        }

        @Override
        public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
            // Only the saved server's own sign-in; the window never shows another origin anyway.
            String own = Uri.parse(origin).getHost();
            if (own == null || !(own.equals(host) || own.equals("[" + host + "]"))) {
                handler.cancel();
                return;
            }
            String[] saved = Prefs.login(MainActivity.this);
            if (saved != null && !usedSavedLogin) {
                usedSavedLogin = true; // asked again on the same load: the saved one was refused
                handler.proceed(saved[0], saved[1]);
            } else {
                askForLogin(handler);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            usedSavedLogin = false;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            ((ViewGroup) view.getParent()).removeView(view);
            view.destroy();
            web = null;
            recreate();
            return true;
        }
    }

    private final class LineupChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pickedFiles != null) pickedFiles.onReceiveValue(null);
            pickedFiles = callback;
            try {
                startActivityForResult(params.createIntent(), PICK_FILE);
                return true;
            } catch (ActivityNotFoundException missing) {
                pickedFiles = null;
                return false;
            }
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            leaveFullscreen();
            fullscreen = view;
            fullscreenDone = callback;
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
        }

        @Override
        public void onHideCustomView() {
            leaveFullscreen();
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }
    }
}
