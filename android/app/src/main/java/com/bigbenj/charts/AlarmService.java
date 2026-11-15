package com.bigbenj.charts;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Reçoit les alertes de prix envoyées par le serveur, même application fermée,
 * et fait sonner le téléphone en boucle (son d'alarme) jusqu'à ce que l'utilisateur touche la notification.
 */
public class AlarmService extends FirebaseMessagingService {
    static final String CHANNEL = "alertes_prix_alarme";
    static final String EXTRA_ID = "notification_id";

    @Override
    public void onNewToken(String token) {
        getSharedPreferences(StartActivity.PREFS, MODE_PRIVATE).edit().putString(StartActivity.KEY_TOKEN, token).apply();
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String title = data.containsKey("title") ? data.get("title") : "Alerte de prix";
        String body = data.containsKey("body") ? data.get("body") : "";
        String tag = data.containsKey("tag") ? data.get("tag") : "bbc";
        ring(this, title, body, tag);
    }

    private static Uri alarmSound() {
        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return sound;
    }

    private static AudioAttributes alarmAudio() {
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
    }

    /** Canal « Alertes de prix » : importance maximale, son d'alarme, vibration longue, visible sur l'écran verrouillé. */
    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Alertes de prix", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Sonne quand un prix atteint une de tes alertes.");
        ch.setSound(alarmSound(), alarmAudio());
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[]{0, 800, 400, 800, 400, 1200});
        ch.enableLights(true);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ch.setBypassDnd(true); // pris en compte seulement si l'utilisateur l'autorise dans les réglages
        nm.createNotificationChannel(ch);
    }

    static void ring(Context ctx, String title, String body, String tag) {
        ensureChannel(ctx);
        int id = tag.hashCode();
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;

        Intent open = new Intent(ctx, StartActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openApp = PendingIntent.getActivity(ctx, id, open, flags);
        Intent stop = new Intent(ctx, StopReceiver.class).putExtra(EXTRA_ID, id);
        PendingIntent stopRing = PendingIntent.getBroadcast(ctx, id, stop, flags);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL) : new Notification.Builder(ctx);
        b.setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(openApp)
                .setDeleteIntent(stopRing)
                .setFullScreenIntent(openApp, true)
                .addAction(new Notification.Action.Builder(null, "Arrêter", stopRing).build());
        if (Build.VERSION.SDK_INT < 26) {
            b.setPriority(Notification.PRIORITY_MAX).setSound(alarmSound(), alarmAudio()).setVibrate(new long[]{0, 800, 400, 800});
        }
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT; // le son se répète jusqu'à ce que la notification soit touchée
        ctx.getSystemService(NotificationManager.class).notify(id, n);
    }
}
