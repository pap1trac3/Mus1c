#pragma once

#include <juce_core/juce_core.h>
#include <array>

namespace SomaticPulse
{
/**
    Lock-free hand-off of post-DSP audio from the audio thread to the editor.

    Single producer (audio thread), single consumer (UI timer), which is
    exactly what `juce::AbstractFifo` is for. The audio thread never blocks:
    if the editor is closed or stalled the buffer simply fills and the oldest
    frames are dropped, because a dropped pixel costs nothing and a dropped
    audio buffer costs an xrun.
*/
class ScopeBuffer
{
public:
    static constexpr int capacity = 8192;

    /** Audio thread. Never allocates, never blocks. */
    void push (float left, float right) noexcept
    {
        const auto scope = fifo.write (1);

        if (scope.blockSize1 > 0)
        {
            dataL[static_cast<size_t> (scope.startIndex1)] = left;
            dataR[static_cast<size_t> (scope.startIndex1)] = right;
        }
        else if (scope.blockSize2 > 0)
        {
            dataL[static_cast<size_t> (scope.startIndex2)] = left;
            dataR[static_cast<size_t> (scope.startIndex2)] = right;
        }
        else
        {
            // Reader has fallen behind. Drop the oldest frame and take its
            // slot rather than stalling here.
            discard (1);

            const auto retry = fifo.write (1);

            if (retry.blockSize1 > 0)
            {
                dataL[static_cast<size_t> (retry.startIndex1)] = left;
                dataR[static_cast<size_t> (retry.startIndex1)] = right;
            }
        }

        fifo.finishedWrite (1);
    }

    /** UI thread. Returns how many frames were copied out. */
    int read (float* destL, float* destR, int maxFrames) noexcept
    {
        const auto wanted = juce::jmin (maxFrames, fifo.getNumReady());
        const auto scope = fifo.read (wanted);

        int written = 0;

        for (int i = 0; i < scope.blockSize1; ++i, ++written)
        {
            destL[written] = dataL[static_cast<size_t> (scope.startIndex1 + i)];
            destR[written] = dataR[static_cast<size_t> (scope.startIndex1 + i)];
        }

        for (int i = 0; i < scope.blockSize2; ++i, ++written)
        {
            destL[written] = dataL[static_cast<size_t> (scope.startIndex2 + i)];
            destR[written] = dataR[static_cast<size_t> (scope.startIndex2 + i)];
        }

        fifo.finishedRead (written);
        return written;
    }

    void clear() noexcept
    {
        fifo.reset();
        dataL.fill (0.0f);
        dataR.fill (0.0f);
    }

private:
    void discard (int frames) noexcept
    {
        const auto scope = fifo.read (frames);
        fifo.finishedRead (scope.blockSize1 + scope.blockSize2);
    }

    juce::AbstractFifo fifo { capacity };
    std::array<float, capacity> dataL {};
    std::array<float, capacity> dataR {};
};
} // namespace SomaticPulse
