using System.Windows;
using Microsoft.Win32;

namespace Agent.Host.Themes;

public enum AppTheme
{
    /// <summary>Follow the Windows app theme, and keep following it if the user changes it.</summary>
    System,
    Light,
    Dark
}

/// <summary>
/// Swaps the palette dictionary at runtime.
///
/// The application's merged dictionaries are ordered [palette, Controls.xaml]. Only slot 0 is
/// replaced, so the control styles are parsed once and keep working - they resolve colours
/// through DynamicResource, which re-evaluates when the dictionary underneath changes.
/// </summary>
public static class ThemeManager
{
    private const int PaletteSlot = 0;

    private static readonly Uri LightUri = new("Themes/Light.xaml", UriKind.Relative);
    private static readonly Uri DarkUri = new("Themes/Dark.xaml", UriKind.Relative);

    private static bool _followingSystem;

    public static AppTheme Current { get; private set; } = AppTheme.System;

    public static void Apply(AppTheme theme)
    {
        Current = theme;

        var effective = theme == AppTheme.System ? DetectSystemTheme() : theme;
        var uri = effective == AppTheme.Dark ? DarkUri : LightUri;

        var dictionaries = System.Windows.Application.Current.Resources.MergedDictionaries;
        var palette = new ResourceDictionary { Source = uri };

        if (dictionaries.Count > PaletteSlot) dictionaries[PaletteSlot] = palette;
        else dictionaries.Insert(PaletteSlot, palette);

        // Only subscribe while actually following the system, and only once - leaving the
        // handler attached after the user picks an explicit theme would let a Windows theme
        // change silently override their choice.
        if (theme == AppTheme.System && !_followingSystem)
        {
            SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
            _followingSystem = true;
        }
        else if (theme != AppTheme.System && _followingSystem)
        {
            SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
            _followingSystem = false;
        }
    }

    /// <summary>Cycles System -> Light -> Dark -> System, which is what the toggle button does.</summary>
    public static AppTheme Cycle()
    {
        var next = Current switch
        {
            AppTheme.System => AppTheme.Light,
            AppTheme.Light => AppTheme.Dark,
            _ => AppTheme.System
        };

        Apply(next);
        return next;
    }

    private static void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e)
    {
        if (e.Category != UserPreferenceCategory.General) return;

        // Marshal onto the UI thread: SystemEvents fires on its own thread and touching
        // Application.Resources from there throws.
        System.Windows.Application.Current?.Dispatcher.Invoke(() => Apply(AppTheme.System));
    }

    /// <summary>
    /// Reads Windows' own app-theme preference. AppsUseLightTheme is 0 for dark, 1 for light;
    /// a missing value means an older build with no dark mode, so light is the safe default.
    /// </summary>
    private static AppTheme DetectSystemTheme()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");

            return key?.GetValue("AppsUseLightTheme") is int value && value == 0
                ? AppTheme.Dark
                : AppTheme.Light;
        }
        catch
        {
            return AppTheme.Light;
        }
    }
}
