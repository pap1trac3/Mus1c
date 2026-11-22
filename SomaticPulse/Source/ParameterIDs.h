#pragma once

/**
    Every APVTS parameter ID in one place.

    These strings are written into DAW project files the moment a user automates
    a control, so they are a compatibility surface: rename one and every saved
    session silently loses that automation lane. Add new IDs, never repurpose
    old ones.
*/
namespace SomaticPulse::ParamID
{
    // --- Binaural sub-oscillator -------------------------------------------
    // The carrier and beat "quick-snap" selectors are UI controls, not
    // parameters: they only ever write to carrierHz / beatHz. Making them
    // automatable too would mean two parameters that can disagree about the
    // same frequency, and a host replaying them in either order.
    inline constexpr auto oscEnable   = "osc_enable";
    inline constexpr auto carrierHz   = "carrier_hz";
    inline constexpr auto beatHz      = "beat_hz";
    inline constexpr auto oscWave     = "osc_wave";
    inline constexpr auto oscDrive    = "osc_drive";
    inline constexpr auto subLevelDb  = "sub_level_db";

    // --- Somatic pulse LFO --------------------------------------------------
    inline constexpr auto lfoEnable      = "lfo_enable";
    inline constexpr auto lfoSync        = "lfo_sync";
    inline constexpr auto lfoRateHz      = "lfo_rate_hz";
    inline constexpr auto lfoDivision    = "lfo_division";
    inline constexpr auto lfoShape       = "lfo_shape";
    inline constexpr auto lfoDepthSub    = "lfo_depth_sub";
    inline constexpr auto lfoDepthAudio  = "lfo_depth_audio";
    inline constexpr auto lfoDepthFilter = "lfo_depth_filter";
    inline constexpr auto lfoStereoPhase = "lfo_stereo_phase";

    // --- Solfeggio resonator and tuning ------------------------------------
    inline constexpr auto resoEnable    = "reso_enable";
    inline constexpr auto resoBaseHz    = "reso_base_hz";
    inline constexpr auto resoQ         = "reso_q";
    inline constexpr auto resoHarmonics = "reso_harmonics";
    inline constexpr auto resoAmount    = "reso_amount";
    inline constexpr auto detuneEnable  = "detune_enable";
    inline constexpr auto detuneCents   = "detune_cents";

    // --- Mix, dynamics and phase safety ------------------------------------
    inline constexpr auto duckEnable    = "duck_enable";
    inline constexpr auto duckAmount    = "duck_amount";
    inline constexpr auto duckAttackMs  = "duck_attack_ms";
    inline constexpr auto duckReleaseMs = "duck_release_ms";
    inline constexpr auto crossoverHz   = "crossover_hz";
    inline constexpr auto headphoneMode = "headphone_mode";
    inline constexpr auto dryWet        = "dry_wet";
    inline constexpr auto outputGainDb  = "output_gain_db";
    inline constexpr auto limiterEnable = "limiter_enable";
    inline constexpr auto ceilingDb     = "ceiling_db";
}
