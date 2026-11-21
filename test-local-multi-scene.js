
process.env.HEADLESS = 'false';

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { config } from './src/config.js';
import { connectDB } from './src/db.js';
import { GoogleFxFlowTool, closeSharedContext } from './src/tools/googleFxFlow.js';

config.browser.headless = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
    console.log('🚀 Starting Multi-Scene Flow Local Test...');
    console.log(`Headless mode: ${config.browser.headless}`);

    try {
        await connectDB();
    } catch (e) {
        console.warn('DB connect warning (will proceed):', e.message);
    }

    const promptPath = path.resolve(__dirname, '../working-promt.txt');
    const masterPrompt = fs.readFileSync(promptPath, 'utf8');

    const storyboardUrl = 'https://pub-75ebbb525c7a4d16a42a0b939e098133.r2.dev/avatars/avatar_6a85c9d832ecd7207bd69418_1795270913021.png';
    console.log(`Using storyboard reference URL: ${storyboardUrl}`);

    const tool = new GoogleFxFlowTool();

    const TOTAL_SCENES = 3;
    const sceneResults = [];

    // ── SCENE 1 ──
    const scene1ItemId = `test_scene1_${Date.now()}`;
    console.log(`\n========================================`);
    console.log(`🎬 RUNNING SCENE 1 (totalScenes: ${TOTAL_SCENES}, sceneNumber: 1)`);
    console.log(`========================================`);

    const result1 = await tool.execute({
        itemId: scene1ItemId,
        prompt: masterPrompt.trim(),
        type: 'avatar_video',
        mediaUrl: storyboardUrl,
        avatarName: 'me',
        sceneNumber: 1,
        totalScenes: TOTAL_SCENES,
        isFirstScene: true,
    });

    console.log('\n✅ SCENE 1 COMPLETED!');
    console.log('Video URL:', result1?.videoUrl || result1?.r2Url || 'N/A');
    console.log('Local Video Path:', result1?.localVideoPath || 'N/A');
    console.log('Last Frame Extracted:', result1?.lastFramePath || result1?.lastFrameUrl || 'NO');
    sceneResults.push(result1);

    // ── SCENES 2 to TOTAL_SCENES ──
    for (let sceneNum = 2; sceneNum <= TOTAL_SCENES; sceneNum++) {
        const prevResult = sceneResults[sceneNum - 2];
        const prevLastFrame = prevResult?.lastFramePath || prevResult?.lastFrameUrl || null;

        const sceneItemId = `test_scene${sceneNum}_${Date.now()}`;
        console.log(`\n========================================`);
        console.log(`🎬 RUNNING SCENE ${sceneNum} (totalScenes: ${TOTAL_SCENES}, sceneNumber: ${sceneNum})`);
        console.log(`========================================`);
        console.log(`Passing Scene ${sceneNum - 1} Last Frame to Scene ${sceneNum}: ${prevLastFrame}`);

        const scenePrompt = `Generate the Scene ${sceneNum} video now, using the storyboard image and the final frame of the previous scene as the continuation reference. Refer to the reference image included in the images.`;

        const result = await tool.execute({
            itemId: sceneItemId,
            prompt: scenePrompt,
            type: 'avatar_video',
            mediaUrl: null,
            avatarName: 'me',
            sceneNumber: sceneNum,
            totalScenes: TOTAL_SCENES,
            isFirstScene: false,
            previousSceneLastFrameUrl: prevLastFrame,
        });

        console.log(`\n✅ SCENE ${sceneNum} COMPLETED!`);
        console.log('Video URL:', result?.videoUrl || result?.r2Url || 'N/A');
        console.log('Local Video Path:', result?.localVideoPath || 'N/A');
        console.log('Last Frame Extracted:', result?.lastFramePath || result?.lastFrameUrl || 'NO');
        sceneResults.push(result);
    }

    // ── MERGE ALL SCENES INTO FINAL VIDEO ──
    const validVideoPaths = sceneResults.map(r => r?.localVideoPath).filter(p => p && fs.existsSync(p));

    if (validVideoPaths.length >= 2) {
        const downloadDir = path.dirname(validVideoPaths[0]);
        const finalMergedPath = path.join(downloadDir, `final_merged_${TOTAL_SCENES}_scenes_${Date.now()}.mp4`);
        console.log(`\n========================================`);
        console.log(`🎞️ MERGING ${validVideoPaths.length} SCENE VIDEOS...`);
        validVideoPaths.forEach((p, idx) => console.log(`Scene ${idx + 1}: ${p}`));
        console.log(`Output : ${finalMergedPath}`);
        console.log(`========================================`);

        const concatListPath = path.join(downloadDir, `concat_${Date.now()}.txt`);
        const listContent = validVideoPaths.map(p => `file '${p}'`).join('\n') + '\n';
        fs.writeFileSync(concatListPath, listContent);

        try {
            execSync(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${finalMergedPath}"`, { stdio: 'pipe' });
            console.log(`\n🎉 ✅ FINAL MERGED VIDEO CREATED (stream copy): ${finalMergedPath}`);
        } catch (copyErr) {
            console.warn(`Stream copy concat failed (${copyErr.message}), falling back to filter concat...`);
            const inputs = validVideoPaths.map(p => `-i "${p}"`).join(' ');
            const filterInputs = validVideoPaths.map((_, i) => `[${i}:v][${i}:a]`).join('');
            const filterStr = `"${filterInputs}concat=n=${validVideoPaths.length}:v=1:a=1[v][a]"`;
            execSync(`ffmpeg -y ${inputs} -filter_complex ${filterStr} -map "[v]" -map "[a]" -c:v libx264 -c:a aac "${finalMergedPath}"`, { stdio: 'pipe' });
            console.log(`\n🎉 ✅ FINAL MERGED VIDEO CREATED (re-encoded): ${finalMergedPath}`);
        }

        try { fs.unlinkSync(concatListPath); } catch {}
    } else {
        console.warn('⚠️ Could not find enough local video files to merge.');
    }

    if (config.browser.headless) {
        await closeSharedContext();
    } else {
        console.log('📌 Headful mode: keeping browser open so you can inspect the final video!');
    }
    console.log('\n🎉 ALL SCENES TEST COMPLETED SUCCESSFULLY IN SAME PROJECT!');
}

run().catch(async (err) => {
    console.error('❌ Error during local test:', err);
    console.log('📌 Keeping browser open so you can inspect the state...');
    setInterval(() => {}, 60000);
});
