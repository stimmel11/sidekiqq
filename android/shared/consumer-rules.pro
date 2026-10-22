# kotlinx.serialization: keep generated serializers for SideKiqq models.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers @kotlinx.serialization.Serializable class com.sidekiqq.shared.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.sidekiqq.shared.**$$serializer { *; }
