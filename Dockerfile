# 使用受支持的 Node LTS + Debian bookworm，避免 buster 源失效
FROM node:20-bookworm-slim AS builder

# 设置工作目录
WORKDIR /home

# 先复制依赖清单，尽量命中 Docker 层缓存
COPY package.json yarn.lock ./
COPY vender/cloud189-sdk/package.json vender/cloud189-sdk/yarn.lock ./vender/cloud189-sdk/

# 安装依赖
RUN cd vender/cloud189-sdk && yarn install --frozen-lockfile
RUN yarn install --frozen-lockfile

# 再复制源码，避免源码改动导致依赖层失效
COPY tsconfig.json ./
COPY src ./src
COPY vender/cloud189-sdk ./vender/cloud189-sdk

# 构建
RUN cd vender/cloud189-sdk && yarn build
RUN yarn build

# 构建生产版本
FROM node:20-bookworm-slim AS production

# 设置工作目录
WORKDIR /home

COPY --from=builder /home/package.json ./
COPY --from=builder /home/yarn.lock ./
COPY --from=builder /home/node_modules ./node_modules

# 复制构建好的代码
COPY --from=builder /home/dist ./dist
COPY --from=builder /home/src/public ./dist/public
# 复制cloud189-sdk编译后的代码到./vender/cloud189-sdk/dist
COPY --from=builder /home/vender/cloud189-sdk/dist ./vender/cloud189-sdk/dist

# 安装必要的依赖项
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates tzdata && \
    rm -rf /var/lib/apt/lists/*
    

# 设置时区
ENV TZ=Asia/Shanghai
RUN ln -sf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone
    
# 创建数据目录
RUN mkdir -p /home/data

# 创建STRM目录
RUN mkdir -p /home/strm

# 挂载点
VOLUME ["/home/data", "/home/strm"]
# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["yarn", "start"]
