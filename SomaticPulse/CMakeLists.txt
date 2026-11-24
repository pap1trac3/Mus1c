cmake_minimum_required(VERSION 3.22)

project(SomaticPulse VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Default to Release. A plugin built -O0 will not keep up in a DAW.
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

option(SOMATICPULSE_COPY_PLUGIN_AFTER_BUILD
       "Copy the built plug-in into the system VST3/AU folder after each build" ON)

# ---------------------------------------------------------------------------
# JUCE
#
# Prefer a local checkout (-DJUCE_DIR=/path/to/JUCE); fall back to fetching a
# pinned release so a clean clone still configures without arguments.
# ---------------------------------------------------------------------------
set(SOMATICPULSE_JUCE_TAG "8.0.15" CACHE STRING "JUCE release tag used by FetchContent")

if(DEFINED JUCE_DIR AND EXISTS "${JUCE_DIR}/CMakeLists.txt")
    message(STATUS "SomaticPulse: using local JUCE at ${JUCE_DIR}")
    add_subdirectory("${JUCE_DIR}" "${CMAKE_BINARY_DIR}/JUCE" EXCLUDE_FROM_ALL)
else()
    message(STATUS "SomaticPulse: fetching JUCE ${SOMATICPULSE_JUCE_TAG}")
    include(FetchContent)
    FetchContent_Declare(JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG        ${SOMATICPULSE_JUCE_TAG}
        GIT_SHALLOW    TRUE)
    FetchContent_MakeAvailable(JUCE)
endif()

# ---------------------------------------------------------------------------
# Formats
#
# AU is a macOS-only target: the AudioUnit SDK ships with Xcode, so asking for
# it elsewhere fails at configure time rather than producing anything useful.
# ---------------------------------------------------------------------------
set(SOMATICPULSE_FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND SOMATICPULSE_FORMATS AU)
endif()
message(STATUS "SomaticPulse: building formats: ${SOMATICPULSE_FORMATS}")

juce_add_plugin(SomaticPulse
    COMPANY_NAME                "Somatic Audio"
    BUNDLE_ID                   "com.somaticaudio.somaticpulse"
    PLUGIN_MANUFACTURER_CODE    Smtc
    PLUGIN_CODE                 Spls
    PRODUCT_NAME                "SomaticPulse"
    FORMATS                     ${SOMATICPULSE_FORMATS}
    VST3_CATEGORIES             Fx Modulation Spatial
    AU_MAIN_TYPE                kAudioUnitType_Effect
    IS_SYNTH                    FALSE
    NEEDS_MIDI_INPUT            FALSE
    NEEDS_MIDI_OUTPUT           FALSE
    IS_MIDI_EFFECT              FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD     ${SOMATICPULSE_COPY_PLUGIN_AFTER_BUILD})

set(SOMATICPULSE_SOURCES
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp
    Source/FactoryPresets.cpp
    Source/DSP/BinauralOscillator.cpp
    Source/DSP/SolfeggioResonator.cpp
    Source/DSP/SomaticPulseLFO.cpp
    Source/DSP/PhaseSafeCrossover.cpp
    Source/DSP/TactileSend.cpp
    Source/DSP/LoudnessMeter.cpp
    Source/UI/CustomLookAndFeel.cpp
    Source/UI/WaveformVisualizer.cpp)

target_sources(SomaticPulse PRIVATE ${SOMATICPULSE_SOURCES})

target_include_directories(SomaticPulse PRIVATE Source)

target_compile_definitions(SomaticPulse PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_STRICT_REFCOUNTEDPOINTER=1)

# Note: JUCE 8.0.15 no longer has a splash screen, so JUCE_DISPLAY_SPLASH_SCREEN
# is deliberately not set - this version ignores it and warns if it is.

target_link_libraries(SomaticPulse
    PRIVATE
        juce::juce_audio_utils
        juce::juce_dsp
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags)

# ---------------------------------------------------------------------------
# Warnings and optimisation
#
# Applied to our own target only - JUCE's own modules are not warning-clean
# under -Wpedantic and we do not want to patch them.
# ---------------------------------------------------------------------------
if(MSVC)
    target_compile_options(SomaticPulse PRIVATE /W4)
    target_compile_options(SomaticPulse PRIVATE $<$<CONFIG:Release>:/O2>)
else()
    target_compile_options(SomaticPulse PRIVATE -Wall -Wextra -Wpedantic)
    target_compile_options(SomaticPulse PRIVATE $<$<CONFIG:Release>:-O3>)
endif()

# ---------------------------------------------------------------------------
# Offline verification harness
#
# Off by default: it is not part of the plug-in. It builds the same DSP into a
# console app that renders test signals and measures them, so the behaviour
# claimed for the engine can be checked rather than taken on trust.
#
#   cmake -S . -B build -DSOMATICPULSE_BUILD_TOOLS=ON
#   cmake --build build --target SomaticPulseVerify
#   ./build/SomaticPulseVerify_artefacts/Release/SomaticPulseVerify
# ---------------------------------------------------------------------------
option(SOMATICPULSE_BUILD_TOOLS "Build the offline verification harness" OFF)

if(SOMATICPULSE_BUILD_TOOLS)
    juce_add_console_app(SomaticPulseVerify PRODUCT_NAME "SomaticPulseVerify")

    target_sources(SomaticPulseVerify PRIVATE
        Tools/OfflineRender.cpp
        ${SOMATICPULSE_SOURCES})

    target_include_directories(SomaticPulseVerify PRIVATE Source)

    target_compile_definitions(SomaticPulseVerify PRIVATE
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_STRICT_REFCOUNTEDPOINTER=1)

    target_link_libraries(SomaticPulseVerify
        PRIVATE
            juce::juce_audio_utils
            juce::juce_dsp
        PUBLIC
            juce::juce_recommended_config_flags)

    if(MSVC)
        target_compile_options(SomaticPulseVerify PRIVATE /W4)
    else()
        target_compile_options(SomaticPulseVerify PRIVATE -Wall -Wextra -Wpedantic)
    endif()
endif()
