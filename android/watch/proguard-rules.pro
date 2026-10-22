# SideKiqq watch. The :shared module should ship its own consumer rules for its JSON models.
# TODO(phone-bot): add consumer-rules.pro to :shared if it uses kotlinx.serialization / reflection.
-keep class com.sidekiqq.watch.tile.** { *; }
-keep class com.sidekiqq.watch.complication.** { *; }
-keep class com.sidekiqq.watch.wearable.** { *; }
