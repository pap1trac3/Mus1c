#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

namespace SomaticPulse::FactoryPresets
{
    /** How many presets the dropdown and the host's program list contain. */
    int getNumPresets() noexcept;

    juce::String getPresetName (int index);

    /**
        Writes a preset's values into the APVTS.

        Values are stored in real units (hertz, decibels, percent, choice
        indices) and converted to normalised form here, so the tables below
        stay readable and survive a change to a parameter's range.

        Call from the message thread: this goes through
        `setValueNotifyingHost`, so the host sees the automation move.
    */
    void applyPreset (int index, juce::AudioProcessorValueTreeState& state);
}
