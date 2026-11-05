# 大川学堂助手 重新打包脚本
# 用法：.\build.ps1
# 依赖：Node.js 22+（需要全局 WebSocket / fetch），npx（用于 postject）
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$node = (Get-Command node -ErrorAction Stop).Source
$ver = & $node -p "process.versions.node"
Write-Host "使用 Node $ver ($node)"

if ([version]($ver -replace '-.*$','') -lt [version]"22.0.0") {
    throw "Node 版本过低，需要 22+"
}

Write-Host "[1/4] 生成 SEA blob"
& $node --experimental-sea-config sea-config.json

Write-Host "[2/4] 复制 node.exe"
Copy-Item $node "大川学堂助手.exe" -Force

Write-Host "[3/4] 去掉原有签名"
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($signtool) {
    & $signtool.Source remove /s "大川学堂助手.exe"
} else {
    Write-Host "   未找到 signtool，跳过（未签名的 node.exe 通常无需此步）"
}

Write-Host "[4/4] 注入 blob"
& npx --yes postject "大川学堂助手.exe" NODE_SEA_BLOB sea-prep.blob `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

Write-Host "完成：$PSScriptRoot\大川学堂助手.exe"
Get-Item "大川学堂助手.exe" | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
