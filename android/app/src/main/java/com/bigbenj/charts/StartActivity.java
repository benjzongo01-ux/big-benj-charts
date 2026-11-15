package com.bigbenj.charts;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.google.androidbrowserhelper.trusted.LauncherActivity;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Écran de démarrage invisible : récupère l'identifiant de ce téléphone pour les alertes (Firebase Cloud Messaging),
 * puis ouvre le site en plein écran en lui transmettant cet identifiant, pour que le serveur sache où sonner.
 */
public class StartActivity extends Activity {
    static final String PREFS = "bbc";
    static final String KEY_TOKEN = "fcm_token";
    private static final int ASK_NOTIFICATIONS = 1;
    private boolean launched = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android 13 et plus : l'autorisation d'afficher des notifications est demandée une fois.
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, ASK_NOTIFICATIONS);
        } else {
            fetchTokenThenLaunch();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        fetchTokenThenLaunch();
    }

    private void fetchTokenThenLaunch() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String saved = prefs.getString(KEY_TOKEN, null);
        // Au plus 4 secondes d'attente : sans réseau, l'application s'ouvre quand même.
        new Handler(Looper.getMainLooper()).postDelayed(() -> launch(saved), 4000);
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                String token = task.isSuccessful() ? task.getResult() : saved;
                if (token != null) prefs.edit().putString(KEY_TOKEN, token).apply();
                launch(token);
            });
        } catch (RuntimeException e) {
            launch(saved); // Firebase mal configuré : l'application reste utilisable, sans sonnerie native
        }
    }

    private void launch(String token) {
        if (launched || isFinishing()) return;
        launched = true;
        Uri.Builder url = Uri.parse(getString(R.string.site_url)).buildUpon();
        Uri incoming = getIntent().getData();
        if (incoming != null && getString(R.string.site_host).equals(incoming.getHost())) url = incoming.buildUpon();
        if (token != null) url.appendQueryParameter("native_token", token);
        Intent open = new Intent(this, LauncherActivity.class);
        open.setAction(Intent.ACTION_VIEW);
        open.setData(url.build());
        startActivity(open);
        finish();
        overridePendingTransition(0, 0);
    }
}
