import pandas as pd
import numpy as np
import sqlite3
from glob import glob
from datetime import datetime
import os
import schedule
import time

# ---------------------------
# CONFIG
# ---------------------------
input_folder = "/Users/ryanhealey/Downloads/daily_summaries/"
network_snapshot_folder = "/Users/ryanhealey/Downloads/network_snapshots/"
output_folder = "/Users/ryanhealey/Downloads/daily_summaries/"
os.makedirs(output_folder, exist_ok=True)

db_path = "/Users/ryanhealey/Downloads/tower_metrics.db"
conn = sqlite3.connect(db_path)

# ---------------------------
# NETWORK METRICS UPDATE FUNCTION (every 30 min)
# ---------------------------
def update_network_metrics():
    today_file = datetime.now().strftime("%m%d%Y")
    pattern = os.path.join(network_snapshot_folder, f"tower_snapshot_{today_file}_*.csv")
    snapshot_files = glob(pattern)

    if not snapshot_files:
        print(f"No network snapshots found for {today_file}")
        return

    df = pd.concat([pd.read_csv(f) for f in snapshot_files], ignore_index=True)
    df_summary = df.groupby(["tower_id","location"]).agg(
        avg_latency_ms=("latency_ms","mean"),
        avg_packet_loss_pct=("packet_loss_pct","mean"),
        outage_rate_pct=("outage_flag","mean")
    ).reset_index()
    
    df_summary[["avg_latency_ms","avg_packet_loss_pct","outage_rate_pct"]] = df_summary[
        ["avg_latency_ms","avg_packet_loss_pct","outage_rate_pct"]
    ].round(2)

    # Frontend variable
    frontend_network_metrics = df_summary.to_dict(orient="records")
    print(f"[{datetime.now()}] Network metrics updated for frontend.")
    # Here you can also write to a CSV or database table if needed

# ---------------------------
# FULL DAILY HAPPINESS INDEX FUNCTION (runs once at midnight)
# ---------------------------
def compute_daily_happiness_index():
    today_file = datetime.now().strftime("%m%d%Y")
    today_csv = datetime.now().strftime("%m/%d/%y")
    
    # -----------------------
    # NETWORK PERFORMANCE (weighted 20%)
    # -----------------------
    network_pattern = os.path.join(input_folder, f"tower_averages_{today_file}_*.csv")
    network_files = glob(network_pattern)
    if not network_files:
        print(f"No daily network snapshots found for {today_csv}")
        return

    df_network = pd.concat([pd.read_csv(f) for f in network_files], ignore_index=True)
    daily_network_summary = df_network.groupby(["tower_id","location"]).agg(
        daily_avg_latency_ms=("avg_latency_ms","mean"),
        daily_avg_packet_loss_pct=("avg_packet_loss_pct","mean"),
        daily_outage_rate_pct=("outage_rate_pct","mean")
    ).reset_index()

    # Compute overall market averages
    network_avg_latency = daily_network_summary["daily_avg_latency_ms"].mean()
    network_avg_packet = daily_network_summary["daily_avg_packet_loss_pct"].mean()
    network_avg_outage = daily_network_summary["daily_outage_rate_pct"].mean()

    benchmarks = {"latency_best":25,"latency_worst":80,
                  "packet_best":0.2,"packet_worst":1.5,
                  "outage_best":0.5,"outage_worst":4.0}

    def metric_score(value,best,worst):
        score = 100*(worst-value)/(worst-best)
        return max(0,min(100,score))

    latency_score = metric_score(network_avg_latency,benchmarks["latency_best"],benchmarks["latency_worst"])
    packet_score = metric_score(network_avg_packet,benchmarks["packet_best"],benchmarks["packet_worst"])
    outage_score = metric_score(network_avg_outage,benchmarks["outage_best"],benchmarks["outage_worst"])

    performance_index = round(0.4*latency_score + 0.3*packet_score + 0.3*outage_score,2)
    weighted_network_score = round(performance_index*0.2,2)
    
    # -----------------------
    # BEHAVIORAL ENGAGEMENT (weighted 50%)
    # -----------------------
    df_behavior = pd.read_csv(os.path.join(input_folder,f"daily_summary_{today_file}.csv"))
    np.random.seed(42)
    df_behavior["behavioral_engagement_score"] = np.random.randint(50,100,size=len(df_behavior))

    suburbs_data = {
        "Downtown":{"median_income":80000,"population":5000,"sales_today":450},
        "North Dallas":{"median_income":120000,"population":6000,"sales_today":600},
        "Oak Cliff":{"median_income":50000,"population":4000,"sales_today":300}
    }
    quota_df = pd.DataFrame([{"location":loc,**vals} for loc,vals in suburbs_data.items()])
    avg_income = quota_df["median_income"].mean()
    base_quota_per_capita=0.1
    quota_df["expected_quota"] = quota_df["population"]*base_quota_per_capita*(quota_df["median_income"]/avg_income)

    def normalize_quota(actual,expected):
        ratio = actual/expected
        if ratio>=1.2: return 100
        elif ratio<=0.5: return 0
        else: return round((ratio-0.5)/(1.2-0.5)*100,2)

    quota_df["quota_performance_score"] = quota_df.apply(
        lambda row: normalize_quota(row["sales_today"],row["expected_quota"]),axis=1
    )

    df_behavior = df_behavior.merge(quota_df[["location","quota_performance_score"]],on="location",how="left")
    df_behavior["locational_score"] = round(0.7*df_behavior["behavioral_engagement_score"] + 0.3*df_behavior["quota_performance_score"],2)
    overall_behavior_score = round(df_behavior["locational_score"].mean(),2)
    weighted_behavior_score = round(overall_behavior_score*0.5,2)
    
    # -----------------------
    # CONSUMER SENTIMENT (weighted 20%)
    # -----------------------
    feedback_file = "/Users/ryanhealey/Downloads/customer_feedback_today.csv"
    feedback_df = pd.read_csv(feedback_file)
    feedback_df["average_score_1_5"] = feedback_df[["review_score","survey_score"]].mean(axis=1)
    competitor_min=3.0
    competitor_max=4.5
    feedback_df["satisfaction_0_100"] = feedback_df["average_score_1_5"].apply(
        lambda x: round((max(competitor_min,min(competitor_max,x))-competitor_min)/(competitor_max-competitor_min)*100,2)
    )
    location_sentiment = feedback_df.groupby("location").agg(satisfaction_0_100=("satisfaction_0_100","mean")).reset_index()
    weighted_consumer_sentiment = round(location_sentiment["satisfaction_0_100"].mean()*0.2,2)

    # -----------------------
    # BRAND MARKET SCORE (weighted 10%)
    # -----------------------
    social_file = "/Users/ryanhealey/Downloads/social_metrics_today.csv"
    social_df = pd.read_csv(social_file)
    social_df["raw_score"] = (0.4*social_df["ad_reach"]+0.15*social_df["shares"]+0.15*social_df["likes"]+
                              0.15*social_df["posts"]+0.15*social_df["comments"])
    competitor_min=100
    competitor_max=1000
    social_df["normalized_score_0_100"] = social_df["raw_score"].apply(
        lambda x: round((max(competitor_min,min(competitor_max,x))-competitor_min)/(competitor_max-competitor_min)*100,2)
    )
    location_brand_scores = social_df.groupby("location").agg(brand_market_score=("normalized_score_0_100","mean")).reset_index()
    weighted_brand_score = round(location_brand_scores["brand_market_score"].mean()*0.1,2)

    # -----------------------
    # FINAL CUSTOMER HAPPINESS INDEX
    # -----------------------
    overall_happiness_index = round(weighted_network_score + weighted_behavior_score +
                                    weighted_consumer_sentiment + weighted_brand_score,2)

    print(f"[{datetime.now()}] Daily Overall Customer Happiness Index: {overall_happiness_index}")

# ---------------------------
# SCHEDULE TASKS
# ---------------------------
# Network metrics every 30 minutes
schedule.every(30).minutes.do(update_network_metrics)

# Full daily happiness index at midnight
schedule.every().day.at("00:00").do(compute_daily_happiness_index)

print("Scheduler started. Running tasks...")
while True:
    schedule.run_pending()
    time.sleep(10)  # check every 10 seconds