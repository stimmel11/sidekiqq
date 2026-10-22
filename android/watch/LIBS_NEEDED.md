# Catalog entries the :watch module still needs

Checked against `android/gradle/libs.versions.toml` as of 2026-10-16. Already present and used:
core-ktx, activity-compose, lifecycle-runtime-ktx, lifecycle-viewmodel-compose, compose-bom,
compose-ui(+tooling/preview), wear-compose-foundation, play-services-wearable,
kotlinx-coroutines-android / -play-services, junit, and the plugins android-application,
kotlin-android, kotlin-compose, kotlin-serialization.

**Please add these** under the `# watch` markers. The watch bot did not edit the catalog, because
it is owned by the phone bot.

```toml
[versions]
# watch
wearComposeMaterial = "1.5.1"      # M2 Wear material; same release train as wearComposeFoundation
wearTiles = "1.5.0"
wearProtolayout = "1.3.0"
wearWatchface = "1.2.1"            # complications data source
wearInput = "1.2.0"
work = "2.10.5"

[libraries]
# watch
androidx-wear-compose-material = { group = "androidx.wear.compose", name = "compose-material", version.ref = "wearComposeMaterial" }
androidx-wear-compose-navigation = { group = "androidx.wear.compose", name = "compose-navigation", version.ref = "wearComposeFoundation" }
androidx-wear-tiles = { group = "androidx.wear.tiles", name = "tiles", version.ref = "wearTiles" }
androidx-wear-protolayout = { group = "androidx.wear.protolayout", name = "protolayout", version.ref = "wearProtolayout" }
androidx-wear-watchface-complications-data-source-ktx = { group = "androidx.wear.watchface", name = "watchface-complications-data-source-ktx", version.ref = "wearWatchface" }
androidx-wear-input = { group = "androidx.wear", name = "wear-input", version.ref = "wearInput" }
androidx-work-runtime-ktx = { group = "androidx.work", name = "work-runtime-ktx", version.ref = "work" }
kotlinx-coroutines-guava = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-guava", version.ref = "coroutines" }
```

Versions are best-known stable lines, not verified against Google Maven from this sandbox.
Pairing rule: wear tiles 1.5.x goes with protolayout 1.3.x (tiles 1.4.x with protolayout 1.2.x).

## Notes
- The catalog already has `androidx-wear-compose-material3` (1.5.1), which the watch does **not**
  use. The UI is built on Wear Compose **Material (M2)**, whose API (Chip, ToggleChip, Card,
  Scaffold/TimeText/PositionIndicator) has been stable for years. Remove the material3 alias if
  nothing else uses it, or keep it for a later M3 migration.
- Horologist is deliberately not used.
- `settings.gradle.kts` already includes `:watch`.
