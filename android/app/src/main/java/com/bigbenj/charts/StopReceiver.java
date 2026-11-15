package com.bigbenj.charts;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Bouton « Arrêter » de la notification : coupe la sonnerie. */
public class StopReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        int id = intent.getIntExtra(AlarmService.EXTRA_ID, 0);
        ctx.getSystemService(NotificationManager.class).cancel(id);
    }
}
