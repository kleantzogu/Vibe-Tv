# What R8 must not remove or rename in a release build.

# The app's own plugins and Capacitor: their methods are found by name and annotation at run time,
# when the page calls them.
-keep class com.vibetv.app.** { *; }
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public <methods>;
}
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# Readable crash reports.
-keepattributes SourceFile, LineNumberTable
